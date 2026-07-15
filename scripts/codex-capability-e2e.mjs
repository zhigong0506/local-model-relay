import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `codex-capability-${stamp}`
const createdProviders = []
const createdRoutes = []
let mock
let verifiedHits = 0
let unverifiedHits = 0

try {
  const config = await api('/api/config')
  mock = await startMock()
  const port = mock.address().port
  const unverified = await createProvider('TMP Codex unverified', port, 10, 'unverified-key')
  const verified = await createProvider('TMP Codex verified', port, 20, 'verified-key')
  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      enabled: true,
      targets: [
        { providerId: unverified.id, model, priority: 10 },
        { providerId: verified.id, model, priority: 20 },
      ],
    },
  })
  createdRoutes.push(route)

  const capability = await api(`/api/providers/${verified.id}/codex-test`, {
    method: 'POST',
    body: { model, credentialId: verified.activeCredentialId },
  })
  const afterTest = await api('/api/config')
  const persisted = afterTest.providers.find((item) => item.id === verified.id)?.capabilities?.codex?.models?.[model]

  const relayResponse = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.service.localApiKey}`,
    },
    body: JSON.stringify({ model, stream: true, input: 'return codex capability text' }),
  })
  const text = await relayResponse.text()
  const state = await api('/api/state')
  const latest = state.requestLog[0]
  const report = {
    ok: capability.ok &&
      persisted?.status === 'verified' &&
      relayResponse.status === 200 &&
      text.includes('CODEX_CAPABILITY_OK') &&
      unverifiedHits >= 1 &&
      verifiedHits >= 1,
    capability,
    persisted,
    relay: {
      status: relayResponse.status,
      unverifiedHits,
      verifiedHits,
      finalProvider: latest?.providerName,
    },
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  for (const route of createdRoutes.reverse()) await api(`/api/routes/${route.id}`, { method: 'DELETE' }).catch(() => {})
  for (const provider of createdProviders.reverse()) await api(`/api/providers/${provider.id}`, { method: 'DELETE' }).catch(() => {})
  if (mock) await new Promise((resolve) => mock.close(resolve))
}

async function createProvider(name, port, priority, apiKey) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      credentials: [{ label: 'mock', apiKey, enabled: true }],
      activeCredentialId: '',
      authMode: 'authorization',
      wireApi: 'responses',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 1,
      models: [model],
      enabled: true,
      tags: ['tmp-codex-capability-test'],
    },
  })
  createdProviders.push(provider)
  return provider
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const isVerified = req.headers.authorization === 'Bearer verified-key'
    const isHeaderProbe = body.input === 'Reply with exactly: CODEX_HEADER_OK'
    // The unverified provider is never expected to receive a routed request;
    // the capability probe only targets the verified one after its route order.
    if (req.url !== '/v1/responses') {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    if (isHeaderProbe && (
      req.headers.originator !== 'codex_cli_rs' ||
      req.headers.version !== '0.144.2' ||
      req.headers['user-agent'] !== 'codex_cli_rs/0.144.2'
    )) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: { message: 'missing codex request headers' } }))
      return
    }
    if (isVerified) verifiedHits += 1
    else unverifiedHits += 1
    sse(res, 'response.created', { response: { id: `resp_${stamp}`, status: 'in_progress', output: [] } })
    const output = isHeaderProbe ? 'CODEX_HEADER_OK' : 'CODEX_CAPABILITY_OK'
    sse(res, 'response.output_text.delta', { response_id: `resp_${stamp}`, item_id: 'msg_1', output_index: 0, content_index: 0, delta: output })
    sse(res, 'response.output_text.done', { response_id: `resp_${stamp}`, item_id: 'msg_1', output_index: 0, content_index: 0, text: output })
    sse(res, 'response.completed', { response: { id: `resp_${stamp}`, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] } })
    res.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
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
