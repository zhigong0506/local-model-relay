export const WIRE_CHAT = 'chat'
export const WIRE_RESPONSES = 'responses'
export const WIRE_AUTO = 'auto'

const TRANSFORMABLE_APIS = new Set([WIRE_CHAT, WIRE_RESPONSES])

export function buildWirePlan(requestUrl, provider) {
  const incomingApi = detectWireApi(requestUrl)
  const providerWireApi = provider.wireApi || WIRE_CHAT
  const upstreamApi = TRANSFORMABLE_APIS.has(incomingApi)
    ? (providerWireApi === WIRE_AUTO ? incomingApi : providerWireApi)
    : incomingApi

  return {
    incomingApi,
    upstreamApi,
    transform: TRANSFORMABLE_APIS.has(incomingApi) &&
      TRANSFORMABLE_APIS.has(upstreamApi) &&
      incomingApi !== upstreamApi,
  }
}

export function buildWireUrl(baseUrl, requestUrl, plan) {
  const request = new URL(requestUrl, 'http://local')
  const parsedBase = new URL(baseUrl)
  const trimmedPath = parsedBase.pathname.replace(/\/+$/, '')
  const normalizedBase = trimmedPath === ''
    ? `${parsedBase.origin}/v1`
    : baseUrl.replace(/\/+$/, '')
  const suffix = endpointSuffix(plan.upstreamApi, request.pathname)
  return `${normalizedBase}${suffix}${request.search}`
}

export function buildWireBody(body, candidate, serviceConfig, plan) {
  const withModel = {
    ...body,
    model: candidate.model,
  }
  const upstreamBody = transformRequestBody(withModel, plan)

  if (
    serviceConfig.collectUsage &&
    serviceConfig.collectStreamUsage &&
    upstreamBody.stream === true &&
    plan.upstreamApi === WIRE_CHAT
  ) {
    upstreamBody.stream_options = {
      ...(upstreamBody.stream_options &&
      typeof upstreamBody.stream_options === 'object' &&
      !Array.isArray(upstreamBody.stream_options)
        ? upstreamBody.stream_options
        : {}),
      include_usage: true,
    }
  }

  return upstreamBody
}

export async function transformWireResponse(upstreamResponse, res, plan) {
  const contentType = upstreamResponse.headers.get('content-type') || ''
  const text = await upstreamResponse.text()

  if (contentType.includes('text/event-stream')) {
    const transformed = transformSse(text, plan)
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.end(transformed.text)
    return transformed.usage
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    res.setHeader('content-type', contentType || 'text/plain; charset=utf-8')
    res.end(text)
    return null
  }

  const transformed = transformResponsePayload(payload, plan)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(transformed))
  return normalizeUsagePayload(transformed?.usage)
}

export function transformRequestBody(body, plan) {
  if (!plan.transform) return { ...body }
  if (plan.incomingApi === WIRE_CHAT && plan.upstreamApi === WIRE_RESPONSES) {
    return chatRequestToResponses(body)
  }
  if (plan.incomingApi === WIRE_RESPONSES && plan.upstreamApi === WIRE_CHAT) {
    return responsesRequestToChat(body)
  }
  return { ...body }
}

export function transformResponsePayload(payload, plan) {
  if (!plan.transform) return payload
  if (payload?.error) return payload
  if (plan.incomingApi === WIRE_CHAT && plan.upstreamApi === WIRE_RESPONSES) {
    return responsesPayloadToChat(payload)
  }
  if (plan.incomingApi === WIRE_RESPONSES && plan.upstreamApi === WIRE_CHAT) {
    return chatPayloadToResponses(payload)
  }
  return payload
}

export function normalizeUsagePayload(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null

  const inputTokens = toTokenCount(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = toTokenCount(usage.completion_tokens ?? usage.output_tokens)
  const cachedTokens = toTokenCount(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cache_read_tokens,
  )
  const cacheWriteTokens = toTokenCount(
    usage.cache_creation_input_tokens ??
    usage.cache_write_input_tokens ??
    usage.cache_write_tokens,
  )
  const totalTokens = toTokenCount(usage.total_tokens) || inputTokens + outputTokens

  if (!inputTokens && !outputTokens && !cachedTokens && !cacheWriteTokens && !totalTokens) return null
  return { inputTokens, outputTokens, cachedTokens, cacheWriteTokens, totalTokens }
}

function detectWireApi(requestUrl) {
  const path = new URL(requestUrl, 'http://local').pathname.replace(/\/+$/, '')
  if (path === '/v1/responses' || path === '/responses') return WIRE_RESPONSES
  if (path === '/v1/chat/completions' || path === '/chat/completions') return WIRE_CHAT
  return 'passthrough'
}

function endpointSuffix(api, originalPath) {
  if (api === WIRE_RESPONSES) return '/responses'
  if (api === WIRE_CHAT) return '/chat/completions'
  return originalPath.startsWith('/v1') ? originalPath.slice('/v1'.length) : originalPath
}

function chatRequestToResponses(body) {
  const {
    messages,
    max_tokens: maxTokens,
    max_completion_tokens: maxCompletionTokens,
    stream_options: _streamOptions,
    n: _n,
    ...rest
  } = body
  const { input, instructions } = messagesToResponsesInput(messages)
  const out = {
    ...rest,
    input: rest.input ?? input,
  }
  if (instructions && !out.instructions) out.instructions = instructions
  const maxOutputTokens = rest.max_output_tokens ?? maxCompletionTokens ?? maxTokens
  if (maxOutputTokens !== undefined) out.max_output_tokens = maxOutputTokens
  return out
}

function responsesRequestToChat(body) {
  const {
    input,
    instructions,
    max_output_tokens: maxOutputTokens,
    text: _text,
    reasoning: _reasoning,
    ...rest
  } = body
  const out = {
    ...rest,
    messages: responsesInputToMessages(input, instructions),
  }
  if (maxOutputTokens !== undefined && out.max_tokens === undefined && out.max_completion_tokens === undefined) {
    out.max_tokens = maxOutputTokens
  }
  return out
}

function messagesToResponsesInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { input: '' }
  const instructions = []
  const input = []

  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : 'user'
    const content = contentToText(message?.content)
    if (role === 'system' || role === 'developer') {
      if (content) instructions.push(content)
      continue
    }
    input.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    })
  }

  return {
    input: input.length ? input : messages.map((message) => ({
      role: normalizeMessageRole(message?.role),
      content: contentToText(message?.content),
    })),
    instructions: instructions.join('\n\n'),
  }
}

function responsesInputToMessages(input, instructions = '') {
  const messages = []
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions.trim() })
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
        continue
      }
      if (!item || typeof item !== 'object') continue
      if (item.type && item.type !== 'message') continue
      messages.push({
        role: normalizeMessageRole(item.role),
        content: contentToText(item.content ?? item.text),
      })
    }
  }

  return messages.length ? messages : [{ role: 'user', content: '' }]
}

function responsesPayloadToChat(payload) {
  const text = readResponsesText(payload)
  const usage = responsesUsageToChatUsage(payload?.usage)
  return {
    id: payload?.id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: payload?.created || payload?.created_at || Math.floor(Date.now() / 1000),
    model: payload?.model || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: payload?.status === 'incomplete' ? 'length' : 'stop',
    }],
    usage,
  }
}

function chatPayloadToResponses(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null
  const text = contentToText(choice?.message?.content ?? choice?.text ?? '')
  return {
    id: payload?.id?.startsWith('resp_') ? payload.id : `resp_${payload?.id || Date.now()}`,
    object: 'response',
    created_at: payload?.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: payload?.model || '',
    output: [{
      id: `msg_${payload?.id || Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    output_text: text,
    usage: chatUsageToResponsesUsage(payload?.usage),
  }
}

function transformSse(text, plan) {
  if (plan.incomingApi === WIRE_CHAT && plan.upstreamApi === WIRE_RESPONSES) {
    return responsesSseToChatSse(text)
  }
  if (plan.incomingApi === WIRE_RESPONSES && plan.upstreamApi === WIRE_CHAT) {
    return chatSseToResponsesSse(text)
  }
  return { text, usage: null }
}

function responsesSseToChatSse(text) {
  let fullText = ''
  let usage = null
  const out = []

  for (const event of parseSse(text)) {
    if (!event.data || event.data === '[DONE]') continue
    const payload = parseJson(event.data)
    if (!payload) continue
    usage = normalizeUsagePayload(payload.usage) || normalizeUsagePayload(payload.response?.usage) || usage
    const delta = typeof payload.delta === 'string' ||
      event.event === 'response.output_text.delta' ||
      payload.type === 'response.output_text.delta'
      ? contentToText(payload.delta ?? payload.text ?? '')
      : ''
    if (!delta) continue
    fullText += delta
    out.push(sseData({
      id: payload.response_id || payload.response?.id || payload.id || `chatcmpl_${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || '',
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    }))
  }

  out.push(sseData({
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usage ? internalUsageToChatUsage(usage) : undefined,
  }))
  out.push('data: [DONE]\n\n')
  return { text: out.join(''), usage }
}

function chatSseToResponsesSse(text) {
  let fullText = ''
  let usage = null
  const responseId = `resp_${Date.now()}`
  const out = [
    sseEvent('response.created', {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        output: [],
      },
    }),
  ]

  for (const event of parseSse(text)) {
    if (!event.data || event.data === '[DONE]') continue
    const payload = parseJson(event.data)
    if (!payload) continue
    usage = normalizeUsagePayload(payload.usage) || usage
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
    const delta = contentToText(choice?.delta?.content ?? '')
    if (!delta) continue
    fullText += delta
    out.push(sseEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      response_id: responseId,
      item_id: `msg_${responseId}`,
      output_index: 0,
      content_index: 0,
      delta,
    }))
  }

  const completed = {
    id: responseId,
    object: 'response',
    status: 'completed',
    output: [{
      id: `msg_${responseId}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    }],
    output_text: fullText,
    usage: usage ? internalUsageToResponsesUsage(usage) : undefined,
  }
  out.push(sseEvent('response.completed', { type: 'response.completed', response: completed }))
  return { text: out.join(''), usage }
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = { event: '', data: '' }
      const data = []
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event.event = line.slice(6).trim()
        if (line.startsWith('data:')) data.push(line.slice(5).trim())
      }
      event.data = data.join('\n')
      return event
    })
    .filter((event) => event.event || event.data)
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function readResponsesText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  if (typeof payload?.delta === 'string') return payload.delta
  if (payload?.response && typeof payload.response === 'object') return readResponsesText(payload.response)
  const parts = []
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (typeof content?.text === 'string') parts.push(content.text)
      if (typeof content?.delta === 'string') parts.push(content.delta)
    }
  }
  return parts.join('')
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      return ''
    })
    .join('')
}

function normalizeMessageRole(role) {
  return role === 'assistant' || role === 'system' || role === 'developer' ? role : 'user'
}

function responsesUsageToChatUsage(usage) {
  const internal = normalizeUsagePayload(usage)
  return internal ? internalUsageToChatUsage(internal) : usage
}

function chatUsageToResponsesUsage(usage) {
  const internal = normalizeUsagePayload(usage)
  return internal ? internalUsageToResponsesUsage(internal) : usage
}

function internalUsageToChatUsage(usage) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: usage.cachedTokens ? { cached_tokens: usage.cachedTokens } : undefined,
  }
}

function internalUsageToResponsesUsage(usage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    cache_read_input_tokens: usage.cachedTokens || undefined,
    cache_creation_input_tokens: usage.cacheWriteTokens || undefined,
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toTokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}
