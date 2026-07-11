import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `stream-preface-failover-${stamp}`
const idleModel = `stream-idle-failover-${stamp}`
const createdProviders = []
const createdRouteIds = []
let failedEventHits = 0
let idleStreamHits = 0
let fallbackHits = 0

const failedStreamServer = await listen(http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: `failed-${stamp}` } })}\n\n`)
  if (body.model === idleModel) {
    idleStreamHits += 1
    return
  }
  failedEventHits += 1
  res.end(`data: ${JSON.stringify({
    type: 'response.failed',
    response: { status: 'failed', error: { message: 'simulated quota exhausted' } },
  })}\n\n`)
}))

const fallbackServer = await listen(http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  fallbackHits += 1
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    id: `fallback-${stamp}`,
    object: 'response',
    status: 'completed',
    model: body.model,
    output_text: 'STREAM_PREFACE_FAILOVER_OK',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'STREAM_PREFACE_FAILOVER_OK' }],
    }],
    usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 },
  }))
}))

try {
  const config = await api('/api/config')
  await createProvider('TMP stream preface failed', failedStreamServer, 9600)
  await createProvider('TMP stream preface fallback', fallbackServer, 9610)

  for (const virtualModel of [model, idleModel]) {
    const route = await api('/api/routes', {
      method: 'POST',
      body: {
        virtualModel,
        targets: createdProviders.map((provider) => ({
          providerId: provider.id,
          model: virtualModel,
          priority: provider.priority,
        })),
        notes: 'temporary stream failover route',
        enabled: true,
      },
    })
    createdRouteIds.push(route.id)
  }

  const failedEvent = await relayResponse(config.service.localApiKey, model)
  await api(`/api/state/providers/${createdProviders[0].id}/reset`, { method: 'POST' })
  await api('/api/routing/start', {
    method: 'POST',
    body: { providerId: createdProviders[0].id, mode: 'locked' },
  })
  const idle = await relayResponse(config.service.localApiKey, idleModel)
  const report = {
    ok: failedEvent.status === 200 &&
      failedEvent.outputText === 'STREAM_PREFACE_FAILOVER_OK' &&
      failedEvent.providerName === createdProviders[1].name &&
      idle.status === 200 &&
      idle.outputText === 'STREAM_PREFACE_FAILOVER_OK' &&
      idle.providerName === createdProviders[1].name &&
      idle.durationMs >= 4900 &&
      failedEventHits === 1 &&
      idleStreamHits === 1 &&
      fallbackHits === 2,
    failedEvent,
    idle,
    failedEventHits,
    idleStreamHits,
    fallbackHits,
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function createProvider(name, server, priority) {
  const address = server.address()
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `${name} ${stamp}`,
      baseUrl: `http://127.0.0.1:${address.port}`,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'responses',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 2,
      models: [model, idleModel],
      tags: ['tmp-stream-preface-test'],
      notes: 'temporary stream preface failover provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

async function relayResponse(localKey, requestedModel) {
  const startedAt = Date.now()
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({ model: requestedModel, input: 'test stream failover', stream: false }),
  })
  const payload = await response.json()
  return {
    status: response.status,
    providerName: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    outputText: payload?.output_text || '',
    durationMs: Date.now() - startedAt,
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
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
  for (const routeId of createdRouteIds.reverse()) {
    try {
      await api(`/api/routes/${routeId}`, { method: 'DELETE' })
    } catch {}
  }
  for (const provider of createdProviders.reverse()) {
    try {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    } catch {}
  }
  await Promise.all([failedStreamServer, fallbackServer].map((server) =>
    new Promise((resolve) => server.close(resolve)),
  ))
}
