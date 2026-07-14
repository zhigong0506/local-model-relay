import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `session-affinity-${stamp}`
const headerSession = `session-header-${stamp}`
const createdProviders = []
let routeId = ''
const hits = []

const serverA = await startProviderServer('A')
const serverB = await startProviderServer('B')

try {
  const config = await api('/api/config')
  const providerA = await createProvider('A', serverA, 9740)
  const providerB = await createProvider('B', serverB, 9750)
  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: [
        { providerId: providerA.id, model, priority: providerA.priority },
        { providerId: providerB.id, model, priority: providerB.priority },
      ],
      notes: 'temporary session affinity verification route',
      enabled: true,
    },
  })
  routeId = route.id

  const firstHeader = await relayResponses(config.service.localApiKey, {
    model,
    input: 'bind header session',
    stream: false,
  }, { 'x-local-relay-session': headerSession })

  await setRoutingStart(providerB.id, 'locked')
  const secondHeader = await relayResponses(config.service.localApiKey, {
    model,
    input: 'reuse header session',
    stream: false,
  }, { 'x-local-relay-session': headerSession })

  await api(`/api/providers/${providerA.id}`, { method: 'PATCH', body: { enabled: false } })
  const bypassedHeader = await relayResponses(config.service.localApiKey, {
    model,
    input: 'bypass disabled header session',
    stream: false,
  }, { 'x-local-relay-session': headerSession })
  const afterBypass = await api('/api/state')
  const bypassLog = (afterBypass.requestLog || [])[0] || {}

  await api(`/api/providers/${providerA.id}`, { method: 'PATCH', body: { enabled: true } })
  await setRoutingStart(providerA.id, 'locked')
  const previousSeed = await relayResponses(config.service.localApiKey, {
    model,
    input: 'create response binding',
    stream: false,
  })
  await setRoutingStart(providerB.id, 'locked')
  const previousFollowup = await relayResponses(config.service.localApiKey, {
    model,
    input: 'follow prior response binding',
    previous_response_id: previousSeed.id,
    stream: false,
  })
  const finalState = await api('/api/state')
  const serializedBindings = JSON.stringify(finalState.sessionBindings || {})

  const report = {
    ok: firstHeader.status === 200 &&
      firstHeader.provider === providerA.name &&
      firstHeader.id.startsWith('resp_A_') &&
      secondHeader.status === 200 &&
      secondHeader.provider === providerA.name &&
      bypassedHeader.status === 200 &&
      bypassedHeader.provider === providerB.name &&
      (bypassLog.diagnostics || []).some((item) => item.code === 'session_affinity_bypassed') &&
      previousSeed.status === 200 &&
      previousSeed.provider === providerA.name &&
      previousSeed.id.startsWith('resp_A_') &&
      previousFollowup.status === 200 &&
      previousFollowup.provider === providerA.name &&
      !serializedBindings.includes(headerSession) &&
      !serializedBindings.includes(previousSeed.id) &&
      hits.map((hit) => hit.name).join('|') === 'A|A|B|A|A',
    headerAffinity: {
      firstHeader,
      secondHeader,
      bypassedHeader,
      bypassDiagnostic: (bypassLog.diagnostics || []).find((item) => item.code === 'session_affinity_bypassed') || null,
    },
    previousResponseAffinity: {
      seed: previousSeed,
      followup: previousFollowup,
    },
    sessionBindingCount: Object.keys(finalState.sessionBindings || {}).length,
    hitOrder: hits.map((hit) => hit.name),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

function startProviderServer(name) {
  let sequence = 0
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    sequence += 1
    hits.push({ name, method: req.method, url: req.url, body })
    const responseId = `resp_${name}_${stamp}_${sequence}`
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      id: responseId,
      object: 'response',
      status: 'completed',
      model: body.model,
      output_text: `SESSION_${name}_OK`,
      output: [{
        id: `msg_${responseId}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: `SESSION_${name}_OK`, annotations: [] }],
      }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function createProvider(label, server, priority) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP session affinity ${label} ${stamp}`,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'responses',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 0,
      models: [model],
      tags: ['tmp-session-affinity'],
      notes: 'temporary session affinity provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

async function setRoutingStart(providerId, mode) {
  return api('/api/routing/start', {
    method: 'POST',
    body: { providerId, mode },
  })
}

async function relayResponses(localKey, body, extraHeaders = {}) {
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  return {
    status: response.status,
    provider: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    id: payload?.id || '',
    text: payload?.output_text || '',
  }
}

function readBody(req) {
  return (async () => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  })()
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
  if (routeId) {
    try {
      await api(`/api/routes/${routeId}`, { method: 'DELETE' })
    } catch {}
  }
  for (const provider of createdProviders.reverse()) {
    try {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    } catch {}
  }
  await Promise.all([serverA, serverB].map((server) => new Promise((resolve) => server.close(resolve))))
}
