import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const firstModel = `real-test-primary-${stamp}`
const selectedModel = `real-test-selected-${stamp}`
const unsupportedModel = `real-test-unsupported-${stamp}`
const preferredModel = 'gpt-5.6-luna'
const fallbackModel = 'gpt-5.4-mini'
const createdProviders = []
const hits = []
let server

try {
  server = await startMockServer()
  const configuredProvider = await createProvider('configured', [firstModel, selectedModel])
  const valid = await api(`/api/providers/${configuredProvider.id}/real-test`, {
    method: 'POST',
    body: { model: selectedModel, prompt: 'test selected model', maxTokens: 8 },
  })
  const hitsAfterValidTest = hits.length

  const preferredProvider = await createProvider('preferred', [firstModel, fallbackModel, preferredModel])
  const preferred = await api(`/api/providers/${preferredProvider.id}/real-test`, {
    method: 'POST',
    body: { prompt: 'test preferred default model', maxTokens: 8 },
  })

  const fallbackProvider = await createProvider('fallback', [firstModel, fallbackModel])
  const fallback = await api(`/api/providers/${fallbackProvider.id}/real-test`, {
    method: 'POST',
    body: { prompt: 'test fallback default model', maxTokens: 8 },
  })

  const unsupported = await api(`/api/providers/${configuredProvider.id}/real-test`, {
    method: 'POST',
    body: { model: unsupportedModel, prompt: 'must not reach upstream', maxTokens: 8 },
  })

  const emptyProvider = await createProvider('empty', [])
  const noModels = await api(`/api/providers/${emptyProvider.id}/real-test`, {
    method: 'POST',
    body: { prompt: 'must not reach upstream', maxTokens: 8 },
  })

  const report = {
    ok: valid.ok === true &&
      valid.status === 200 &&
      valid.model === selectedModel &&
      valid.content === `MODEL_OK:${selectedModel}` &&
      valid.timeoutMs === 90000 &&
      valid.latencyMs >= 5000 &&
      hitsAfterValidTest === 1 &&
      hits[0]?.body?.model === selectedModel &&
      hits[0]?.body?.stream === true &&
      preferred.ok === true &&
      preferred.model === preferredModel &&
      hits[1]?.body?.model === preferredModel &&
      fallback.ok === true &&
      fallback.model === fallbackModel &&
      hits[2]?.body?.model === fallbackModel &&
      unsupported.ok === false &&
      unsupported.skipped === true &&
      unsupported.reason === 'unsupported_model' &&
      noModels.ok === false &&
      noModels.skipped === true &&
      noModels.reason === 'no_supported_models' &&
      hits.length === 3,
    selectedModel: {
      status: valid.status,
      model: valid.model,
      latencyMs: valid.latencyMs,
      testTimeoutMs: valid.timeoutMs,
      providerTimeoutMs: configuredProvider.timeoutMs,
      upstreamModel: hits[0]?.body?.model || '',
    },
    defaultModelOrder: {
      preferred: preferred.model,
      fallback: fallback.model,
    },
    unsupportedModel: {
      skipped: unsupported.skipped,
      reason: unsupported.reason,
    },
    noSupportedModels: {
      skipped: noModels.skipped,
      reason: noModels.reason,
    },
    upstreamRequestCount: hits.length,
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function createProvider(label, models) {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP real test model ${label} ${stamp}`,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'chat',
      priority: label === 'configured' ? 9900 : 9910,
      timeoutMs: 5000,
      cooldownSeconds: 2,
      models,
      tags: ['tmp-real-test-model'],
      notes: 'temporary real test model selection provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  return provider
}

function startMockServer() {
  const mock = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? JSON.parse(text) : {}
    hits.push({ method: req.method, url: req.url, body })

    if (body.model === selectedModel) {
      await new Promise((resolve) => setTimeout(resolve, 5200))
    }

    res.statusCode = 200
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${stamp}`,
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: `MODEL_OK:${body.model}` }, finish_reason: null }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${stamp}`,
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      id: `chatcmpl-${stamp}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: `MODEL_OK:${body.model}` },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }))
  })

  return new Promise((resolve, reject) => {
    mock.once('error', reject)
    mock.listen(0, '127.0.0.1', () => resolve(mock))
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
  for (const provider of createdProviders.reverse()) {
    try {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    } catch {}
  }
  if (server) await new Promise((resolve) => server.close(resolve))
}
