import { randomUUID } from 'node:crypto'

const SERVER_ITEM_ID = /^(rs|fc|resp|msg)_/
const UNSUPPORTED_FIELDS = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'top_logprobs',
  'n',
  'seed',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'user',
  'prompt_cache_retention',
  'metadata',
  'stream_options',
  'safety_identifier',
  'previous_response_id',
]

export function normalizeCodexOAuthRequest(input, options = {}) {
  const body = structuredClone(input && typeof input === 'object' ? input : {})
  body.input = normalizeInput(body.input)
  normalizeInputItems(body)
  normalizeTools(body)
  normalizeReasoning(body)

  body.instructions = typeof body.instructions === 'string' && body.instructions.trim()
    ? body.instructions
    : 'You are a helpful assistant.'
  body.store = false
  if (body.service_tier === 'fast') body.service_tier = 'priority'
  if (body.service_tier && body.service_tier !== 'priority') delete body.service_tier

  const sessionId = boundedText(options.sessionId, 256)
  if (!body.prompt_cache_key && sessionId) body.prompt_cache_key = sessionId
  for (const field of UNSUPPORTED_FIELDS) delete body[field]
  return body
}

export function resolveCodexOAuthSessionId(headers = {}, body = {}) {
  const headerCandidates = [
    headers.session_id,
    headers['session-id'],
    headers['x-session-id'],
    headers['x-local-relay-session'],
    headers['x-local-model-relay-session'],
    headers['x-client-request-id'],
  ]
  const bodyCandidates = [
    body?.prompt_cache_key,
    body?.session_id,
    body?.conversation_id,
    body?.metadata?.local_relay_session_id,
  ]
  for (const value of [...headerCandidates, ...bodyCandidates]) {
    const selected = boundedText(Array.isArray(value) ? value[0] : value, 256)
    if (selected) return selected
  }
  return randomUUID()
}

function normalizeInput(input) {
  if (typeof input === 'string') {
    return [messageItem('user', input.trim() || '...')]
  }
  if (!Array.isArray(input) || input.length === 0) {
    return [messageItem('user', '...')]
  }
  return input
}

function normalizeInputItems(body) {
  body.input = body.input.filter((item) => {
    if (typeof item === 'string') return !SERVER_ITEM_ID.test(item)
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    if (item.type === 'item_reference') return false
    if (item.role === 'system' && (!item.type || item.type === 'message')) item.role = 'developer'
    if (typeof item.id === 'string' && SERVER_ITEM_ID.test(item.id)) delete item.id
    return true
  }).map((item) => typeof item === 'string' ? messageItem('user', item) : item)

  if (body.input.length === 0) body.input = [messageItem('user', '...')]
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools)) return
  const functionNames = new Set()
  body.tools = body.tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return []
    if (tool.type !== 'function') return typeof tool.type === 'string' && tool.type ? [tool] : []
    const nested = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function)
      ? tool.function
      : {}
    const name = boundedText(tool.name || nested.name, 128)
    if (!name) return []
    functionNames.add(name)
    const parameters = objectValue(tool.parameters) || objectValue(nested.parameters) || {
      type: 'object',
      properties: {},
    }
    return [{
      type: 'function',
      name,
      description: boundedText(tool.description || nested.description, 4096),
      parameters,
      ...(typeof tool.strict === 'boolean' || typeof nested.strict === 'boolean'
        ? { strict: tool.strict ?? nested.strict }
        : {}),
    }]
  })

  if (body.tool_choice?.type === 'function') {
    const name = boundedText(body.tool_choice.name || body.tool_choice.function?.name, 128)
    if (name && functionNames.has(name)) body.tool_choice = { type: 'function', name }
    else delete body.tool_choice
  }
}

function normalizeReasoning(body) {
  const legacyEffort = boundedText(body.reasoning_effort, 32)
  const reasoning = objectValue(body.reasoning)
    ? { ...body.reasoning }
    : legacyEffort
      ? { effort: legacyEffort }
      : { effort: 'low' }
  if (reasoning.effort === 'max') reasoning.effort = 'xhigh'
  if (!reasoning.summary) reasoning.summary = 'auto'
  body.reasoning = reasoning
  delete body.reasoning_effort

  if (reasoning.effort && reasoning.effort !== 'none') {
    const include = Array.isArray(body.include) ? body.include.filter((item) => typeof item === 'string') : []
    if (!include.includes('reasoning.encrypted_content')) include.push('reasoning.encrypted_content')
    body.include = include
  }
}

function messageItem(role, text) {
  return {
    type: 'message',
    role,
    content: [{ type: 'input_text', text }],
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function boundedText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, maxLength)
}
