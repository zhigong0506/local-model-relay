import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `reconnect-failover-e2e-${stamp}`
const threshold = 4
const createdProviders = []
let createdRouteId = ''
let originalService = null
let streamingHits = 0
let fallbackHits = 0

const streamingServer = await startStreamingUpstream()
const fallbackServer = await startFallbackUpstream()

try {
  const config = await api('/api/config')
  originalService = {
    reconnectFailureThreshold: config.service.reconnectFailureThreshold,
    reconnectCooldownSeconds: config.service.reconnectCooldownSeconds,
  }
  await api('/api/service', {
    method: 'PATCH',
    body: {
      reconnectFailureThreshold: threshold,
      reconnectCooldownSeconds: 120,
    },
  })

  createdProviders.push(await createProvider('TMP reconnect stream', serverBaseUrl(streamingServer), 9500))
  createdProviders.push(await createProvider('TMP reconnect fallback', serverBaseUrl(fallbackServer), 9510))

  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: createdProviders.map((provider) => ({
        providerId: provider.id,
        model,
        priority: provider.priority,
      })),
      notes: 'temporary reconnect failover e2e route',
      enabled: true,
    },
  })
  createdRouteId = route.id

  for (let index = 1; index <= threshold; index += 1) {
    await abortRelayStream(config.service.localApiKey)
    await waitForLogCount(index)
  }

  const final = await relayResponse(config.service.localApiKey)
  const state = await api('/api/state')
  const logs = (state.requestLog || []).filter((entry) => entry.model === model)
  const trippedLog = logs.find((entry) =>
    (entry.attempts || []).some((attempt) => attempt.failoverArmed),
  )
  const finalLog = logs.find((entry) => entry.ok && entry.providerName === createdProviders[1].name)
  const streamProviderState = state.providerState?.[createdProviders[0].id]

  const report = {
    ok: final.status === 200 &&
      final.text === 'RECONNECT_FAILOVER_OK' &&
      final.provider === createdProviders[1].name &&
      streamingHits === threshold &&
      fallbackHits === 1 &&
      Boolean(trippedLog) &&
      Number(finalLog?.usage?.cachedTokens || 0) === 2 &&
      Number(streamProviderState?.cooldownUntil || 0) > Date.now(),
    model,
    threshold,
    streamingHits,
    fallbackHits,
    finalStatus: final.status,
    finalProvider: final.provider,
    finalText: final.text,
    circuitTripped: Boolean(trippedLog),
    cachedTokensCaptured: Number(finalLog?.usage?.cachedTokens || 0),
    cooldownActive: Number(streamProviderState?.cooldownUntil || 0) > Date.now(),
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function createProvider(name, baseUrl, priority) {
  return api('/api/providers', {
    method: 'POST',
    body: {
      name,
      baseUrl,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'responses',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 2,
      models: [model],
      tags: ['tmp-reconnect-test'],
      notes: 'temporary reconnect failover e2e provider',
      enabled: true,
    },
  })
}

async function startStreamingUpstream() {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    streamingHits += 1
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: `resp-${stamp}` } })}\n\n`)
    const interval = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(interval)
        return
      }
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })}\n\n`)
    }, 25)
    res.once('close', () => clearInterval(interval))
  })

  return listen(server)
}

async function startFallbackUpstream() {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    fallbackHits += 1
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      id: `resp-${stamp}`,
      object: 'response',
      status: 'completed',
      model,
      output_text: 'RECONNECT_FAILOVER_OK',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'RECONNECT_FAILOVER_OK' }],
      }],
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 2 },
      },
    }))
  })

  return listen(server)
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function serverBaseUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function abortRelayStream(localKey) {
  const controller = new AbortController()
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      input: 'test reconnect failover',
      stream: true,
    }),
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  try {
    await reader.read()
  } catch {}
}

async function relayResponse(localKey) {
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      input: 'test fallback after reconnect failures',
    }),
  })
  const body = await response.json()
  return {
    status: response.status,
    provider: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    text: body?.output_text || '',
  }
}

async function waitForLogCount(expected) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = await api('/api/state')
    const count = (state.requestLog || []).filter((entry) => entry.model === model).length
    if (count >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${expected} reconnect logs.`)
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

  if (originalService) {
    try {
      await api('/api/service', { method: 'PATCH', body: originalService })
    } catch {}
  }

  await Promise.all([streamingServer, fallbackServer].map((server) =>
    new Promise((resolve) => server.close(resolve)),
  ))
}
