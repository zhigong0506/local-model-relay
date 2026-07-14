import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `route-test-e2e-${stamp}`
const createdProviders = []
let routeId = ''
let primaryHits = 0
let fallbackHits = 0

const primaryServer = await listen(http.createServer(async (req, res) => {
  await readBody(req)
  primaryHits += 1
  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: { message: 'simulated primary route test failure' } }))
}))

const fallbackServer = await listen(http.createServer(async (req, res) => {
  const body = await readBody(req)
  fallbackHits += 1
  await delay(45)
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.write(`data: ${JSON.stringify({
    id: `chatcmpl-route-test-${stamp}`,
    object: 'chat.completion.chunk',
    model: body.model,
    choices: [{ index: 0, delta: { content: 'ROUTE_TEST_OK' }, finish_reason: null }],
  })}\n\n`)
  res.write(`data: ${JSON.stringify({
    id: `chatcmpl-route-test-${stamp}`,
    object: 'chat.completion.chunk',
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  })}\n\n`)
  res.end('data: [DONE]\n\n')
}))

try {
  const primary = await createProvider('primary', primaryServer, 9720)
  const fallback = await createProvider('fallback', fallbackServer, 9730)
  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: [
        { providerId: primary.id, model, priority: primary.priority },
        { providerId: fallback.id, model, priority: fallback.priority },
      ],
      notes: 'temporary route test endpoint verification',
      enabled: true,
    },
  })
  routeId = route.id

  const result = await api(`/api/routes/${routeId}/real-test`, {
    method: 'POST',
    body: { prompt: 'Reply with exactly: OK', maxTokens: 8 },
  })
  const state = await api('/api/state')
  const log = (state.requestLog || []).find((entry) => entry.testType === 'route_test' && entry.model === model)
  const disabled = await request(`/api/routes/${routeId}`, {
    method: 'PATCH',
    body: { enabled: false },
  })
  const disabledTest = await request(`/api/routes/${routeId}/real-test`, {
    method: 'POST',
    body: { prompt: 'must not run', maxTokens: 8 },
  })

  const report = {
    ok: result.ok === true &&
      result.providerId === fallback.id &&
      result.providerName === fallback.name &&
      result.routedModel === model &&
      result.content === 'ROUTE_TEST_OK' &&
      result.attempts.length === 2 &&
      result.attempts[0]?.ok === false &&
      result.attempts[0]?.status === 503 &&
      result.attempts[1]?.ok === true &&
      result.attempts[1]?.latencyMs >= 35 &&
      result.latencyMs >= result.attempts[1]?.latencyMs &&
      log?.outcome === 'route_test_success' &&
      log?.attempts?.length === 2 &&
      disabled.status === 200 &&
      disabledTest.status === 409 &&
      disabledTest.body?.error?.type === 'route_disabled' &&
      primaryHits === 1 &&
      fallbackHits === 1,
    result,
    log: log ? {
      outcome: log.outcome,
      attempts: log.attempts?.map((attempt) => ({ providerName: attempt.providerName, status: attempt.status, outcome: attempt.outcome })),
    } : null,
    disabledTest: { status: disabledTest.status, errorType: disabledTest.body?.error?.type || '' },
    upstreamHits: { primaryHits, fallbackHits },
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function createProvider(label, server, priority) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP route test ${label} ${stamp}`,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'chat',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 0,
      models: [model],
      tags: ['tmp-route-test'],
      notes: 'temporary route test provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function api(path, options = {}) {
  const result = await request(path, options)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${result.status}: ${JSON.stringify(result.body)}`)
  }
  return result.body
}

async function request(path, options = {}) {
  const response = await fetch(`${relay}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  }
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
  await Promise.all([primaryServer, fallbackServer].map((server) => new Promise((resolve) => server.close(resolve))))
}
