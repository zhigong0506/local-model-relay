import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `response-validation-${stamp}`
const testModel = `response-validation-test-${stamp}`
const hits = []
const createdProviders = []
let createdRouteId = ''
let upstream

try {
  upstream = await startMockServer()
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
  const first = await createProvider('soft-failure', baseUrl, 'soft-failure-key', model, 9000)
  const second = await createProvider('healthy', baseUrl, 'healthy-key', model, 9010)
  const testProvider = await createProvider('provider-test', baseUrl, 'provider-test-key', testModel, 9020)

  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: [
        { providerId: first.id, model, priority: 9000 },
        { providerId: second.id, model, priority: 9010 },
      ],
    },
  })
  createdRouteId = route.id

  const providerResult = await api(`/api/providers/${testProvider.id}/test`, { method: 'POST' })
  const speedModels = await api('/api/speed-test/models', {
    method: 'POST',
    body: { baseUrl, apiKey: 'speed-test-key' },
  })
  const speedRun = await api('/api/speed-test/run', {
    method: 'POST',
    body: { baseUrl, apiKey: 'speed-test-key', model: testModel, rounds: 1 },
  })

  const config = await api('/api/config')
  const relayResult = await relayChat(config.service.localApiKey)
  const state = await api('/api/state')
  const relayLog = (state.requestLog || []).find((entry) => entry.model === model)
  const providerLog = (state.requestLog || []).find((entry) => entry.providerId === testProvider.id && entry.testType === 'provider_test')
  const routingHitOrder = hits.filter((hit) => hit.kind === 'relay' && ['soft-failure-key', 'healthy-key'].includes(hit.key)).map((hit) => hit.key)
  const report = {
    ok: providerResult.ok === false &&
      providerResult.status === 200 &&
      speedModels.ok === false &&
      speedModels.status === 200 &&
      speedRun.ok === false &&
      speedRun.rounds?.[0]?.ok === false &&
      relayResult.status === 200 &&
      relayResult.text === 'VALID_AFTER_SOFT_FAILURE' &&
      relayResult.attemptsHeader === '2' &&
      routingHitOrder.join('|') === 'soft-failure-key|healthy-key' &&
      providerLog?.testType === 'provider_test' &&
      relayLog?.attempts?.[0]?.outcome === 'upstream_payload_failed',
    http200ProviderTestRejected: !providerResult.ok,
    http200SpeedTestRejected: !speedModels.ok && !speedRun.rounds?.[0]?.ok,
    failoverAfterHttp200Error: relayResult.text === 'VALID_AFTER_SOFT_FAILURE',
    providerTestLog: providerLog ? { testType: providerLog.testType, ok: providerLog.ok, status: providerLog.status } : null,
    speedRound: speedRun.rounds?.[0] ? { ok: speedRun.rounds[0].ok, status: speedRun.rounds[0].status, message: speedRun.rounds[0].message } : null,
    relayHitOrder: routingHitOrder,
    relayFirstOutcome: relayLog?.attempts?.[0]?.outcome || '',
    relayAttempts: relayLog?.attempts?.map((attempt) => ({
      providerName: attempt.providerName,
      status: attempt.status,
      outcome: attempt.outcome,
    })) || [],
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  if (createdRouteId) {
    try { await api(`/api/routes/${createdRouteId}`, { method: 'DELETE' }) } catch {}
  }
  for (const provider of createdProviders.reverse()) {
    try { await api(`/api/providers/${provider.id}`, { method: 'DELETE' }) } catch {}
  }
  if (upstream) await new Promise((resolveClose) => upstream.close(resolveClose))
}

async function createProvider(label, baseUrl, apiKey, providerModel, priority) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP response validation ${label} ${stamp}`,
      baseUrl,
      credentials: [{ label: 'mock', apiKey, enabled: true }],
      authMode: 'authorization',
      wireApi: 'chat',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 1,
      models: [providerModel],
      tags: ['tmp-response-validation'],
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

function startMockServer() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    hits.push({ kind: 'all', method: req.method, url: req.url, key })

    if (req.method === 'GET' && req.url === '/v1/models') {
      if (key === 'provider-test-key' || key === 'speed-test-key') {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: { message: 'soft models failure' } }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ data: [{ id: testModel }] }))
      return
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      hits.push({ kind: 'relay', key })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (key === 'soft-failure-key' || key === 'speed-test-key') {
        res.end(JSON.stringify({ error: { message: 'soft completion failure' } }))
        return
      }
      res.end(JSON.stringify({
        id: `chatcmpl-${stamp}`,
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'VALID_AFTER_SOFT_FAILURE' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

async function relayChat(localKey) {
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${localKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'validate' }], max_tokens: 8 }),
  })
  const body = await response.json()
  return {
    status: response.status,
    text: body?.choices?.[0]?.message?.content || '',
    attemptsHeader: response.headers.get('x-local-relay-attempts'),
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
