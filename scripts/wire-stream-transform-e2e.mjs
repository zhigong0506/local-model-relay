import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const failoverModel = `wire-transform-failover-${stamp}`
const incompleteModel = `wire-transform-incomplete-${stamp}`
const createdProviders = []
const createdRoutes = []
let primaryFailoverHits = 0
let primaryIncompleteHits = 0
let fallbackHits = 0

const primaryServer = await listen(http.createServer(async (req, res) => {
  const body = await readBody(req)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })

  if (body.model === failoverModel) {
    primaryFailoverHits += 1
    res.write(responseEvent('response.created', {
      type: 'response.created',
      response: { id: `resp_primary_fail-${stamp}`, model: body.model },
    }))
    res.end(responseEvent('response.failed', {
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'simulated response stream failure' } },
    }))
    return
  }

  if (body.model === incompleteModel) {
    primaryIncompleteHits += 1
    res.write(responseEvent('response.created', {
      type: 'response.created',
      response: { id: `resp_primary_incomplete-${stamp}`, model: body.model },
    }))
    await delay(45)
    res.write(responseEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      response_id: `resp_primary_incomplete-${stamp}`,
      delta: 'PARTIAL_ONLY',
    }))
    await delay(180)
    res.end()
    return
  }

  res.end(responseEvent('response.completed', {
    type: 'response.completed',
    response: { id: `resp_primary_default-${stamp}`, status: 'completed', model: body.model },
  }))
}))

const fallbackServer = await listen(http.createServer(async (req, res) => {
  const body = await readBody(req)
  fallbackHits += 1
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.write(responseEvent('response.created', {
    type: 'response.created',
    response: { id: `resp_fallback-${stamp}`, model: body.model },
  }))
  await delay(70)
  res.write(responseEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    response_id: `resp_fallback-${stamp}`,
    delta: 'WIRE_INCREMENTAL_OK',
  }))
  await delay(300)
  res.end(responseEvent('response.completed', {
    type: 'response.completed',
    response: {
      id: `resp_fallback-${stamp}`,
      status: 'completed',
      model: body.model,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  }))
}))

try {
  const config = await api('/api/config')
  const primary = await createProvider('primary', primaryServer, 9700, [failoverModel, incompleteModel])
  const fallback = await createProvider('fallback', fallbackServer, 9710, [failoverModel])
  await createRoute(failoverModel, [primary, fallback])
  await createRoute(incompleteModel, [primary])

  const failover = await relayChatStream(config.service.localApiKey, failoverModel)
  const incomplete = await relayChatStream(config.service.localApiKey, incompleteModel)
  const report = {
    ok: failover.status === 200 &&
      failover.provider === fallback.name &&
      failover.attempts === '2' &&
      failover.text.includes('WIRE_INCREMENTAL_OK') &&
      failover.text.includes('"finish_reason":"stop"') &&
      failover.text.includes('data: [DONE]') &&
      failover.firstChunkAt > 0 &&
      failover.finishedAt - failover.firstChunkAt >= 180 &&
      incomplete.status === 200 &&
      incomplete.text.includes('PARTIAL_ONLY') &&
      !incomplete.text.includes('"finish_reason":"stop"') &&
      !incomplete.text.includes('data: [DONE]') &&
      primaryFailoverHits === 1 &&
      primaryIncompleteHits === 1 &&
      fallbackHits === 1,
    failover,
    incomplete,
    upstreamHits: {
      primaryFailoverHits,
      primaryIncompleteHits,
      fallbackHits,
    },
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function createProvider(label, server, priority, models) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP wire transform ${label} ${stamp}`,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'responses',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 0,
      models,
      tags: ['tmp-wire-stream-transform'],
      notes: 'temporary wire streaming transform test provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

async function createRoute(model, providers) {
  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: providers.map((provider) => ({ providerId: provider.id, model, priority: provider.priority })),
      notes: 'temporary wire transform route',
      enabled: true,
    },
  })
  createdRoutes.push(route)
}

async function relayChatStream(localKey, model) {
  const startedAt = Date.now()
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'run wire stream transform test' }],
      stream: true,
      max_tokens: 8,
    }),
  })

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let text = ''
  let firstChunkAt = 0
  let readError = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      text += chunk
      if (chunk && !firstChunkAt) firstChunkAt = Date.now()
    }
    text += decoder.decode()
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }

  return {
    status: response.status,
    provider: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    attempts: response.headers.get('x-local-relay-attempts') || '',
    text,
    firstChunkAt: firstChunkAt ? firstChunkAt - startedAt : 0,
    finishedAt: Date.now() - startedAt,
    readError,
  }
}

function responseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
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
  for (const route of createdRoutes.reverse()) {
    try {
      await api(`/api/routes/${route.id}`, { method: 'DELETE' })
    } catch {}
  }
  for (const provider of createdProviders.reverse()) {
    try {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    } catch {}
  }
  await Promise.all([primaryServer, fallbackServer].map((server) => new Promise((resolve) => server.close(resolve))))
}
