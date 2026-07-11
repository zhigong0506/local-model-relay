import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `failover-e2e-${stamp}`
const hits = []
const createdProviders = []
let createdRouteId = ''
let originalMaxAttempts = null

const scenarios = [
  { name: 'E2E 01 502', status: 502, message: 'mock 502 from first provider' },
  { name: 'E2E 02 503', status: 503, message: 'mock 503 from second provider' },
  { name: 'E2E 03 403', status: 403, message: 'mock 403 from third provider' },
  { name: 'E2E 04 402', status: 402, message: 'mock 402 from fourth provider' },
  { name: 'E2E 05 OK', status: 200, message: 'FAILOVER_OK' },
]

const servers = await Promise.all(scenarios.map(startMockUpstream))

try {
  const config = await api('/api/config')
  const localKey = config.service.localApiKey
  originalMaxAttempts = config.service.maxAttempts
  if (originalMaxAttempts < scenarios.length) {
    await api('/api/service', {
      method: 'PATCH',
      body: { maxAttempts: scenarios.length },
    })
  }

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index]
    const provider = await api('/api/providers', {
      method: 'POST',
      body: {
        name: `TMP ${scenario.name}`,
        baseUrl: serverBaseUrl(servers[index]),
        credentials: [{ label: 'mock', apiKey: `mock-key-${index + 1}`, enabled: true }],
        authMode: 'authorization',
        wireApi: 'chat',
        priority: 9100 + index * 10,
        timeoutMs: 5000,
        cooldownSeconds: 2,
        models: [model],
        tags: ['tmp-failover-test'],
        notes: 'temporary failover e2e test provider',
        enabled: true,
      },
    })
    createdProviders.push(provider)
  }

  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: createdProviders.map((provider) => ({ providerId: provider.id, model, priority: provider.priority })),
      notes: 'temporary failover e2e test route',
      enabled: true,
    },
  })
  createdRouteId = route.id

  const result = await relayChat(localKey)
  const state = await api('/api/state')
  const log = (state.requestLog || []).find((entry) => entry.model === model)
  const report = {
    ok: result.status === 200 &&
      result.text === 'FAILOVER_OK' &&
      result.attemptsHeader === String(scenarios.length) &&
      hits.map((hit) => hit.name).join('|') === scenarios.map((item) => item.name).join('|'),
    model,
    responseStatus: result.status,
    responseText: result.text,
    attemptsHeader: result.attemptsHeader,
    finalProvider: result.providerHeader,
    upstreamHitOrder: hits.map((hit) => hit.name),
    requestLogAttempts: (log?.attempts || []).map((attempt) => ({
      providerName: attempt.providerName,
      status: attempt.status,
      model: attempt.model,
    })),
    usage: log?.usage || null,
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function startMockUpstream(scenario, index) {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    hits.push({ index: index + 1, name: scenario.name, method: req.method, url: req.url, body: raw })
    res.statusCode = scenario.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(mockBody(scenario)))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function mockBody(scenario) {
  if (scenario.status >= 400) return { error: { message: scenario.message } }
  return {
    id: `chatcmpl-${stamp}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: scenario.message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  }
}

function serverBaseUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function relayChat(localKey) {
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'test failover' }],
      max_tokens: 8,
    }),
  })
  const body = await response.json()
  return {
    status: response.status,
    attemptsHeader: response.headers.get('x-local-relay-attempts'),
    providerHeader: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    text: body?.choices?.[0]?.message?.content || '',
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${relay}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${text}`)
  return body
}

async function cleanup() {
  if (createdRouteId) {
    try {
      await api(`/api/routes/${createdRouteId}`, { method: 'DELETE' })
    } catch {}
  }

  for (const provider of createdProviders.reverse()) {
    try {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    } catch {}
  }

  if (originalMaxAttempts !== null) {
    try {
      await api('/api/service', {
        method: 'PATCH',
        body: { maxAttempts: originalMaxAttempts },
      })
    } catch {}
  }

  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}
