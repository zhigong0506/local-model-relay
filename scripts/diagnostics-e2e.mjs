import assert from 'node:assert/strict'
import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `diagnostics-${stamp}`
const payloadModel = `diagnostics-payload-${stamp}`
const hits = []
const createdProviders = []
const createdRoutes = []
let upstream

try {
  upstream = await startMockUpstream()
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`
  const config = await api('/api/config')
  const localKey = config.service.localApiKey

  const disabled = await createProvider('停用 Key', baseUrl, 'disabled-key', model, 9000, {
    enabled: false,
  })
  const failing = await createProvider('502 线路', baseUrl, 'failing-key', model, 9010)
  const healthy = await createProvider('成功线路', baseUrl, 'healthy-key', model, 9020)
  const payload = await createProvider('HTTP 200 错误包线路', baseUrl, 'payload-key', payloadModel, 9030)

  createdRoutes.push(await createRoute(model, [
    { providerId: disabled.id, model, priority: 9000 },
    { providerId: failing.id, model, priority: 9010 },
    { providerId: healthy.id, model, priority: 9020 },
  ]))
  createdRoutes.push(await createRoute(payloadModel, [
    { providerId: payload.id, model: payloadModel, priority: 9030 },
  ]))

  const failover = await relayChat(localKey, model)
  const afterFailover = await api('/api/state')
  const failoverLog = (afterFailover.requestLog || []).find((entry) => entry.model === model && entry.ok)

  const payloadResult = await relayChat(localKey, payloadModel)
  const afterPayload = await api('/api/state')
  const payloadLog = (afterPayload.requestLog || []).find((entry) => entry.model === payloadModel)
  const ui = await inspectUiAssets()

  const report = {
    ok: failover.status === 200 &&
      failover.text === 'DIAGNOSTICS_OK' &&
      failover.hitOrder.join('|') === 'failing-key|healthy-key' &&
      failoverLog?.diagnostics?.some((item) => item.code === 'no_enabled_key' && item.providerName.includes('停用 Key')) &&
      failoverLog?.diagnostics?.some((item) => item.code === 'upstream_gateway_error' && item.providerName.includes('502 线路')) &&
      failoverLog?.attempts?.[0]?.diagnostic?.code === 'upstream_gateway_error' &&
      payloadResult.status === 502 &&
      payloadLog?.diagnostics?.some((item) => item.code === 'upstream_payload_error') &&
      ui.ok,
    disabledKeySkipped: !hits.some((hit) => hit.key === 'disabled-key'),
    failover: {
      status: failover.status,
      text: failover.text,
      hitOrder: failover.hitOrder,
      diagnostics: failoverLog?.diagnostics?.map((item) => ({ code: item.code, providerName: item.providerName })) || [],
    },
    http200Payload: {
      status: payloadResult.status,
      diagnosticCodes: payloadLog?.diagnostics?.map((item) => item.code) || [],
    },
    ui,
  }

  assert.equal(report.ok, true, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const route of createdRoutes.reverse()) {
    try { await api(`/api/routes/${route.id}`, { method: 'DELETE' }) } catch {}
  }
  for (const provider of createdProviders.reverse()) {
    try { await api(`/api/providers/${provider.id}`, { method: 'DELETE' }) } catch {}
  }
  if (upstream) await new Promise((resolveClose) => upstream.close(resolveClose))
}

async function createProvider(label, baseUrl, apiKey, providerModel, priority, credentialPatch = {}) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP diagnostics ${label}`,
      baseUrl,
      credentials: [{ label: 'mock', apiKey, enabled: true, ...credentialPatch }],
      authMode: 'authorization',
      wireApi: 'chat',
      priority,
      timeoutMs: 5000,
      cooldownSeconds: 0,
      models: [providerModel],
      tags: ['tmp-diagnostics-test'],
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

async function createRoute(virtualModel, targets) {
  return api('/api/routes', {
    method: 'POST',
    body: { virtualModel, targets, tags: ['tmp-diagnostics-test'] },
  })
}

function startMockUpstream() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    hits.push({ key, model: body.model || '', method: req.method, url: req.url })

    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (key === 'failing-key') {
      res.statusCode = 502
      res.end(JSON.stringify({ error: { message: 'mock gateway failure' } }))
      return
    }
    if (key === 'payload-key') {
      res.statusCode = 200
      res.end(JSON.stringify({ error: { message: 'mock error payload' } }))
      return
    }
    res.statusCode = 200
    res.end(JSON.stringify({
      id: `chatcmpl-${stamp}`,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'DIAGNOSTICS_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }))
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

async function relayChat(localKey, requestedModel) {
  const before = hits.length
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model: requestedModel,
      messages: [{ role: 'user', content: 'diagnostics test' }],
      max_tokens: 8,
    }),
  })
  const body = await response.json()
  return {
    status: response.status,
    text: body?.choices?.[0]?.message?.content || '',
    hitOrder: hits.slice(before).map((hit) => hit.key),
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

async function inspectUiAssets() {
  const [scriptResponse, styleResponse] = await Promise.all([
    fetch(`${relay}/assets/js/main.mjs`),
    fetch(`${relay}/assets/styles.css`),
  ])
  const script = await scriptResponse.text()
  const style = await styleResponse.text()
  return {
    ok: scriptResponse.ok && styleResponse.ok &&
      script.includes('logDiagnosticsMarkup') &&
      style.includes('.log-diagnostics'),
    scriptStatus: scriptResponse.status,
    styleStatus: styleResponse.status,
  }
}
