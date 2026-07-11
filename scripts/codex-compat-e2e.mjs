import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `codex-compat-${stamp}`
const createdProviders = []
const createdRoutes = []
const capturedBodies = []
let server

try {
  const config = await api('/api/config')
  const localKey = config.service.localApiKey
  const models = await testModelsEnvelope(localKey)
  server = await startMockServer()
  await createProviderAndRoute()
  const text = await testTextLifecycle(localKey)
  const tool = await testToolLifecycle(localKey)
  const followup = await testToolFollowup(localKey)
  const report = {
    ok: models.ok && text.ok && tool.ok && followup.ok,
    models,
    text,
    tool,
    followup,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function testModelsEnvelope(localKey) {
  const response = await fetch(`${relay}/v1/models?client_version=0.142.5`, {
    headers: { authorization: `Bearer ${localKey}` },
  })
  const body = await response.json()
  return {
    ok: response.status === 200 && Array.isArray(body.data) && Array.isArray(body.models),
    status: response.status,
    openAiModels: Array.isArray(body.data) ? body.data.length : null,
    codexModels: Array.isArray(body.models) ? body.models.length : null,
  }
}

async function testTextLifecycle(localKey) {
  const result = await relayResponses(localKey, {
    model,
    stream: true,
    input: 'return compatibility text',
    max_output_tokens: 16,
  })
  const required = [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]
  return {
    ok: result.status === 200 &&
      required.every((type) => result.types.includes(type)) &&
      inOrder(result.types, required) &&
      result.text === 'CODEX_TEXT_OK',
    status: result.status,
    types: result.types,
    text: result.text,
  }
}

async function testToolLifecycle(localKey) {
  const result = await relayResponses(localKey, {
    model,
    stream: true,
    input: 'call diagnostic_ping',
    tools: [{
      type: 'function',
      name: 'diagnostic_ping',
      description: 'Return a diagnostic pong.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: 'function', name: 'diagnostic_ping' },
  })
  const upstream = capturedBodies.find((body) => Array.isArray(body.tools))
  const functionItem = result.completed?.response?.output?.find((item) => item.type === 'function_call')
  return {
    ok: result.status === 200 &&
      result.types.includes('response.function_call_arguments.delta') &&
      result.types.includes('response.function_call_arguments.done') &&
      result.types.includes('response.output_item.done') &&
      functionItem?.name === 'diagnostic_ping' &&
      functionItem?.arguments === '{"value":"ok"}' &&
      upstream?.tools?.[0]?.function?.name === 'diagnostic_ping' &&
      upstream?.tool_choice?.function?.name === 'diagnostic_ping',
    status: result.status,
    types: result.types,
    functionItem: functionItem || null,
    upstreamToolShape: upstream?.tools?.[0]?.type || '',
  }
}

async function testToolFollowup(localKey) {
  const result = await relayResponses(localKey, {
    model,
    stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call diagnostic_ping' }] },
      {
        type: 'function_call',
        id: 'fc_test',
        call_id: 'call_test',
        name: 'diagnostic_ping',
        arguments: '{"value":"ok"}',
      },
      { type: 'function_call_output', call_id: 'call_test', output: 'PONG_OK' },
    ],
  })
  const upstream = capturedBodies.find((body) =>
    body.messages?.some((message) => message.role === 'tool'),
  )
  const assistant = upstream?.messages?.find((message) => message.role === 'assistant')
  const toolMessage = upstream?.messages?.find((message) => message.role === 'tool')
  return {
    ok: result.status === 200 &&
      result.text === 'CODEX_FOLLOWUP_OK' &&
      assistant?.tool_calls?.[0]?.function?.name === 'diagnostic_ping' &&
      toolMessage?.tool_call_id === 'call_test' &&
      toolMessage?.content === 'PONG_OK',
    status: result.status,
    text: result.text,
    assistantTool: assistant?.tool_calls?.[0]?.function?.name || '',
    toolCallId: toolMessage?.tool_call_id || '',
  }
}

function startMockServer() {
  const mock = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    capturedBodies.push(body)
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')

    if (body.messages?.some((message) => message.role === 'tool')) {
      writeTextStream(res, 'CODEX_FOLLOWUP_OK')
      return
    }
    if (Array.isArray(body.tools)) {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl_${stamp}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_test',
              type: 'function',
              function: { name: 'diagnostic_ping', arguments: '{"value":' },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl_${stamp}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    writeTextStream(res, 'CODEX_TEXT_OK')
  })
  return new Promise((resolve, reject) => {
    mock.once('error', reject)
    mock.listen(0, '127.0.0.1', () => resolve(mock))
  })
}

function writeTextStream(res, value) {
  const midpoint = Math.ceil(value.length / 2)
  for (const delta of [value.slice(0, midpoint), value.slice(midpoint)]) {
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl_${stamp}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({
    id: `chatcmpl_${stamp}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  })}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function relayResponses(localKey, body) {
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  const events = parseSse(raw)
  return {
    status: response.status,
    types: events.map((event) => event.type).filter(Boolean),
    text: events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta || '')
      .join(''),
    completed: events.find((event) => event.type === 'response.completed') || null,
  }
}

function parseSse(raw) {
  const events = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  return events
}

function inOrder(actual, required) {
  let cursor = -1
  for (const type of required) {
    cursor = actual.indexOf(type, cursor + 1)
    if (cursor < 0) return false
  }
  return true
}

async function createProviderAndRoute() {
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: `TMP Codex compatibility ${stamp}`,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'chat',
      priority: 9800,
      timeoutMs: 5000,
      cooldownSeconds: 2,
      models: [model],
      tags: ['tmp-codex-compat-test'],
      notes: 'temporary Codex compatibility test provider',
      enabled: true,
    },
  })
  createdProviders.push(provider)
  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: [{ providerId: provider.id, model, priority: provider.priority }],
      notes: 'temporary Codex compatibility test route',
      enabled: true,
    },
  })
  createdRoutes.push(route)
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
  if (server) await new Promise((resolve) => server.close(resolve))
}
