import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const fallbackModel = `reasoning-fallback-${stamp}`
const isolationModel = `reasoning-isolation-${stamp}`
const hits = []
const providers = []
const routes = []
let upstreamA
let upstreamB

try {
  upstreamA = await startUpstream('A', ({ model, effort }) => {
    if (model === fallbackModel && effort === 'max') return failure(503, 'gpt-test-max: Codex model price is temporarily unavailable.', 'codex_model_price_not_configured')
    if (model === fallbackModel && effort === 'xhigh') return failure(503, 'generic provider outage', 'upstream_unavailable')
    return success(model, 'MAX_SUPPORTED')
  })
  upstreamB = await startUpstream('B', ({ model }) => success(model, 'ISOLATED_MAX_OK'))

  const config = await api('/api/config')
  const localKey = config.service.localApiKey
  const providerA = await createProvider('A', upstreamA, 9700, [fallbackModel, isolationModel])
  const providerB = await createProvider('B', upstreamB, 9710, [fallbackModel])
  providers.push(providerA, providerB)
  routes.push(await createRoute(fallbackModel, [providerA, providerB]))
  routes.push(await createRoute(isolationModel, [providerA]))

  const isolationResult = await relayResponses(localKey, isolationModel)
  const fallbackResult = await relayResponses(localKey, fallbackModel)
  const state = await api('/api/state')
  const fallbackLog = (state.requestLog || []).find((entry) => entry.model === fallbackModel)

  const fallbackHits = hits.filter((hit) => hit.model === fallbackModel)
  const isolationHits = hits.filter((hit) => hit.model === isolationModel)
  const report = {
    ok: fallbackResult.status === 200 &&
      fallbackResult.text === 'ISOLATED_MAX_OK' &&
      fallbackHits.map((hit) => `${hit.provider}:${hit.effort}`).join('|') === 'A:max|A:xhigh|B:max' &&
      fallbackLog?.attempts?.[0]?.reasoningFallback?.from === 'max' &&
      fallbackLog?.attempts?.[0]?.reasoningFallback?.to === 'xhigh' &&
      isolationResult.status === 200 &&
      isolationResult.text === 'MAX_SUPPORTED' &&
      isolationHits.map((hit) => `${hit.provider}:${hit.effort}`).join('|') === 'A:max',
    fallbackHitOrder: fallbackHits.map((hit) => ({ provider: hit.provider, effort: hit.effort })),
    isolationHitOrder: isolationHits.map((hit) => ({ provider: hit.provider, effort: hit.effort })),
    attempts: fallbackLog?.attempts || [],
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  for (const route of routes.reverse()) {
    try { await api(`/api/routes/${route.id}`, { method: 'DELETE' }) } catch {}
  }
  for (const provider of providers.reverse()) {
    try { await api(`/api/providers/${provider.id}`, { method: 'DELETE' }) } catch {}
  }
  await Promise.all([upstreamA, upstreamB].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))))
}

async function startUpstream(provider, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    const effort = body?.reasoning?.effort || body?.reasoning_effort || ''
    hits.push({ provider, model: body.model, effort })
    const result = handler({ model: body.model, effort })
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(result.body))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function failure(status, message, code) {
  return { status, body: { error: { message, code } } }
}

function success(model, text) {
  return {
    status: 200,
    body: {
      id: `resp-${stamp}`,
      object: 'response',
      status: 'completed',
      model,
      output_text: text,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    },
  }
}

async function createProvider(label, server, priority, models) {
  const address = server.address()
  return api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP Reasoning ${label}`,
      baseUrl: `http://127.0.0.1:${address.port}`,
      credentials: [{ label: 'mock', apiKey: `mock-${label}`, enabled: true }],
      authMode: 'authorization',
      wireApi: 'responses',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 2,
      models,
      tags: ['tmp-reasoning-fallback'],
      enabled: true,
    },
  })
}

function createRoute(model, routeProviders) {
  return api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: routeProviders.map((provider) => ({ providerId: provider.id, model, priority: provider.priority })),
      enabled: true,
    },
  })
}

async function relayResponses(localKey, model) {
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${localKey}` },
    body: JSON.stringify({ model, input: 'test reasoning fallback', reasoning: { effort: 'max' } }),
  })
  const body = await response.json()
  return { status: response.status, text: body?.output_text || '' }
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
