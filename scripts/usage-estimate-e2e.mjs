import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const createdProviders = []
const createdRoutes = []
const servers = []

try {
  const config = await api('/api/config')
  const localKey = config.service.localApiKey
  const noUsage = await runNoUsageSuccess(localKey)
  const interrupted = await runInterruptedStream(localKey)
  const toolHandoff = await runToolCallHandoff(localKey)
  const report = {
    ok: noUsage.ok && interrupted.ok && toolHandoff.ok,
    noUsage,
    interrupted,
    toolHandoff,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function runNoUsageSuccess(localKey) {
  const model = `usage-estimate-json-${stamp}`
  const server = await startMockServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      id: `chatcmpl-${stamp}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'NO_USAGE_OK' }, finish_reason: 'stop' }],
    }))
  })
  servers.push(server)
  await createProviderAndRoute(model, server)
  const response = await relayChat(localKey, model, false)
  const log = await waitForLog(model)
  return {
    ok: response.status === 200 && response.text === 'NO_USAGE_OK' && log?.usage?.estimated === true,
    responseStatus: response.status,
    responseText: response.text,
    usage: log?.usage || null,
  }
}

async function runInterruptedStream(localKey) {
  const model = `usage-estimate-abort-${stamp}`
  const server = await startMockServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.write('data: {"choices":[{"delta":{"content":"PARTIAL_USAGE_ESTIMATE"}}]}\n\n')
    const timer = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n')
    }, 200)
    res.on('close', () => clearInterval(timer))
  })
  servers.push(server)
  await createProviderAndRoute(model, server)

  const controller = new AbortController()
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: 'estimate aborted stream usage' }],
      max_tokens: 16,
    }),
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  try {
    await reader.cancel()
  } catch {}

  const log = await waitForLog(model)
  return {
    ok: log?.ok === false &&
      String(log?.error || '').includes('Client disconnected') &&
      log?.usage?.estimated === true,
    responseStatus: response.status,
    loggedStatus: log?.status,
    error: log?.error || '',
    usage: log?.usage || null,
  }
}

async function runToolCallHandoff(localKey) {
  const model = `usage-tool-handoff-${stamp}`
  const server = await startMockServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.write('data: {"type":"response.created","response":{"id":"resp_test","status":"in_progress"}}\n\n')
    res.write('data: {"type":"response.output_item.added","item":{"type":"function_call","name":"diagnostic_ping"}}\n\n')
    res.write('data: {"type":"response.function_call_arguments.delta","delta":"{\\"value\\":\\"ok\\"}"}\n\n')
    res.write('data: {"type":"response.function_call_arguments.done","arguments":"{\\"value\\":\\"ok\\"}"}\n\n')
    const timer = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n')
    }, 200)
    res.on('close', () => clearInterval(timer))
  })
  servers.push(server)
  await createProviderAndRoute(model, server, 'responses')

  const controller = new AbortController()
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      input: 'call diagnostic tool',
      tools: [{
        type: 'function',
        name: 'diagnostic_ping',
        description: 'diagnostic tool',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
    }),
    signal: controller.signal,
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('response.function_call_arguments.done')) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  controller.abort()
  try {
    await reader.cancel()
  } catch {}

  const log = await waitForLog(model)
  return {
    ok: log?.ok === true &&
      log?.outcome === 'tool_call_handoff' &&
      !log?.error &&
      Number(log?.usage?.outputTokens || 0) > 0,
    responseStatus: response.status,
    loggedStatus: log?.status,
    outcome: log?.outcome || '',
    error: log?.error || '',
    stream: log?.stream || null,
    usage: log?.usage || null,
  }
}

async function createProviderAndRoute(model, server, wireApi = 'chat') {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP usage estimate ${model}`,
      baseUrl: serverBaseUrl(server),
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi,
      priority: 9300 + createdProviders.length * 10,
      timeoutMs: 5000,
      cooldownSeconds: 2,
      models: [model],
      tags: ['tmp-usage-estimate-test'],
      notes: 'temporary usage estimate e2e test provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: [{ providerId: provider.id, model, priority: provider.priority }],
      notes: 'temporary usage estimate e2e test route',
      enabled: true,
    },
  })
  createdRoutes.push(route)
}

function startMockServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function serverBaseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`
}

async function relayChat(localKey, model, stream) {
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: 'user', content: 'estimate usage without upstream usage' }],
      max_tokens: 8,
    }),
  })
  const body = await response.json()
  return {
    status: response.status,
    text: body?.choices?.[0]?.message?.content || '',
  }
}

async function waitForLog(model) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await api('/api/state')
    const log = (state.requestLog || []).find((entry) => entry.model === model)
    if (log) return log
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return null
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
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}
