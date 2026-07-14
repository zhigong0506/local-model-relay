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
  const withModel = stripLocalRelayMetadata({
    ...body,
    model: candidate.model,
  })
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

function stripLocalRelayMetadata(body) {
  if (!body?.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) return body
  const metadata = { ...body.metadata }
  delete metadata.local_relay_session_id
  delete metadata.local_model_relay_session_id
  if (Object.keys(metadata).length === 0) {
    const { metadata: _metadata, ...rest } = body
    return rest
  }
  return { ...body, metadata }
}

export async function transformWireResponse(upstreamResponse, res, plan) {
  const contentType = upstreamResponse.headers.get('content-type') || ''

  if (contentType.includes('text/event-stream')) {
    const transformer = createWireStreamTransformer(plan)
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        for (const output of transformer.ingest(chunk)) res.write(output)
      }
    }
    for (const output of transformer.finish()) res.write(output)
    res.end()
    return { usage: transformer.usage(), responseId: transformer.responseId() }
  }

  const text = await upstreamResponse.text()

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    res.setHeader('content-type', contentType || 'text/plain; charset=utf-8')
    res.end(text)
    return { usage: null, responseId: '' }
  }

  const transformed = transformResponsePayload(payload, plan)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(transformed))
  return {
    usage: normalizeUsagePayload(transformed?.usage),
    responseId: responseIdFromPayload(transformed),
  }
}

export function createWireStreamTransformer(plan) {
  if (!plan?.transform) {
    return {
      ingest(chunk) {
        return [chunk]
      },
      finish() {
        return []
      },
      usage() {
        return null
      },
      responseId() {
        return ''
      },
    }
  }

  if (plan.incomingApi === WIRE_CHAT && plan.upstreamApi === WIRE_RESPONSES) {
    return createResponsesToChatStreamTransformer()
  }
  if (plan.incomingApi === WIRE_RESPONSES && plan.upstreamApi === WIRE_CHAT) {
    return createChatToResponsesStreamTransformer()
  }
  return {
    ingest(chunk) {
      return [chunk]
    },
    finish() {
      return []
    },
    usage() {
      return null
    },
    responseId() {
      return ''
    },
  }
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

  const inputTokens = toTokenCount(usage.prompt_tokens ?? usage.input_tokens ?? usage.input)
  const outputTokens = toTokenCount(usage.completion_tokens ?? usage.output_tokens ?? usage.output)
  const cachedTokenValue =
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cache_read_tokens ??
    usage.cacheRead ??
    usage.readCache ??
    usage.cache?.readTokens ??
    usage.cache?.read_tokens ??
    usage.cache?.cachedTokens
  const cachedTokensReported = cachedTokenValue !== undefined && cachedTokenValue !== null
  const cachedTokens = toTokenCount(cachedTokenValue)
  const cacheWriteTokens = toTokenCount(
    usage.cache_creation_input_tokens ??
    usage.cache_write_input_tokens ??
    usage.cache_write_tokens ??
    usage.cacheWrite ??
    usage.writeCache ??
    usage.cache?.writeTokens ??
    usage.cache?.write_tokens ??
    usage.cache?.creationTokens,
  )
  const totalTokens = toTokenCount(usage.total_tokens ?? usage.totalTokens ?? usage.total) || inputTokens + outputTokens

  if (!inputTokens && !outputTokens && !cachedTokens && !cacheWriteTokens && !totalTokens) return null
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    cachedTokensReported,
    cacheWriteTokens,
    totalTokens,
  }
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
    tools,
    tool_choice: toolChoice,
    include: _include,
    previous_response_id: _previousResponseId,
    background: _background,
    conversation: _conversation,
    truncation: _truncation,
    prompt_cache_key: _promptCacheKey,
    safety_identifier: _safetyIdentifier,
    ...rest
  } = body
  const out = {
    ...rest,
    messages: responsesInputToMessages(input, instructions),
  }
  if (Array.isArray(tools)) {
    out.tools = tools.map(responsesToolToChatTool).filter(Boolean)
  }
  if (toolChoice !== undefined) out.tool_choice = responsesToolChoiceToChat(toolChoice)
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
    let assistantToolCalls = []
    const flushAssistantToolCalls = () => {
      if (!assistantToolCalls.length) return
      messages.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls })
      assistantToolCalls = []
    }

    for (const item of input) {
      if (typeof item === 'string') {
        flushAssistantToolCalls()
        messages.push({ role: 'user', content: item })
        continue
      }
      if (!item || typeof item !== 'object') continue

      if (item.type === 'function_call') {
        assistantToolCalls.push({
          id: item.call_id || item.id || `call_${assistantToolCalls.length}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
          },
        })
        continue
      }

      flushAssistantToolCalls()
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: toolOutputToText(item.output),
        })
        continue
      }
      if (item.type && item.type !== 'message') continue
      messages.push({
        role: normalizeMessageRole(item.role),
        content: contentToText(item.content ?? item.text),
      })
    }
    flushAssistantToolCalls()
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
  const messageId = `msg_${payload?.id || Date.now()}`
  const output = []
  if (text) {
    output.push({
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const [index, toolCall] of (choice?.message?.tool_calls || []).entries()) {
    const functionCall = toolCall?.function || {}
    output.push({
      id: toolCall?.id || `fc_${payload?.id || Date.now()}_${index}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall?.id || `call_${index}`,
      name: functionCall.name || '',
      arguments: typeof functionCall.arguments === 'string'
        ? functionCall.arguments
        : JSON.stringify(functionCall.arguments || {}),
    })
  }
  return {
    id: payload?.id?.startsWith('resp_') ? payload.id : `resp_${payload?.id || Date.now()}`,
    object: 'response',
    created_at: payload?.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: payload?.model || '',
    output,
    output_text: text,
    usage: chatUsageToResponsesUsage(payload?.usage),
  }
}

function createResponsesToChatStreamTransformer() {
  const parser = createSseParser()
  const state = {
    responseId: '',
    model: '',
    createdAt: Math.floor(Date.now() / 1000),
    usage: null,
    terminal: false,
    finalEmitted: false,
  }

  const consume = (event) => {
    if (event.data === '[DONE]') {
      state.terminal = true
      return []
    }
    const payload = parseJson(event.data)
    if (!payload) return []
    const type = event.event || payload.type || ''
    const failure = upstreamSseFailureMessage(payload, type)
    if (failure) throw makeWireStreamFailure(failure)

    state.responseId ||= responseIdFromPayload(payload)
    state.model ||= streamModelFromPayload(payload)
    state.createdAt = streamCreatedAtFromPayload(payload, state.createdAt)
    state.usage = normalizeUsagePayload(payload.usage) || normalizeUsagePayload(payload.response?.usage) || state.usage
    if (isResponsesTerminal(payload, type)) state.terminal = true

    const delta = typeof payload.delta === 'string' || type === 'response.output_text.delta'
      ? contentToText(payload.delta ?? payload.text ?? '')
      : ''
    if (!delta) return []

    return [sseData({
      id: state.responseId || `chatcmpl_${Date.now()}`,
      object: 'chat.completion.chunk',
      created: state.createdAt,
      model: state.model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    })]
  }

  const finish = () => {
    if (state.finalEmitted || !state.terminal) return []
    state.finalEmitted = true
    return [
      sseData({
        id: state.responseId || `chatcmpl_${Date.now()}`,
        object: 'chat.completion.chunk',
        created: state.createdAt,
        model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: state.usage ? internalUsageToChatUsage(state.usage) : undefined,
      }),
      'data: [DONE]\n\n',
    ]
  }

  return {
    ingest(chunk) {
      return parser.push(chunk).flatMap(consume)
    },
    finish() {
      const out = parser.finish().flatMap(consume)
      return [...out, ...finish()]
    },
    usage() {
      return state.usage
    },
    responseId() {
      return state.responseId
    },
  }
}

function createChatToResponsesStreamTransformer() {
  const parser = createSseParser()
  const state = {
    started: false,
    responseId: '',
    messageId: '',
    createdAt: Math.floor(Date.now() / 1000),
    model: '',
    output: [],
    outputIndexes: new Map(),
    toolCalls: new Map(),
    fullText: '',
    usage: null,
    messageOutputIndex: -1,
    messageStarted: false,
    nextOutputIndex: 0,
    sequenceNumber: 0,
    terminal: false,
    completedEmitted: false,
  }

  const emit = (out, type, payload) => {
    out.push(sseEvent(type, { type, sequence_number: state.sequenceNumber, ...payload }))
    state.sequenceNumber += 1
  }

  const ensureStarted = (payload, out) => {
    if (state.started) return
    const upstreamId = typeof payload?.id === 'string' ? payload.id : ''
    state.responseId = upstreamId.startsWith('resp_') ? upstreamId : `resp_${upstreamId || Date.now()}`
    state.messageId = `msg_${state.responseId}`
    state.createdAt = streamCreatedAtFromPayload(payload, state.createdAt)
    state.model = streamModelFromPayload(payload)
    state.started = true
    const response = {
      id: state.responseId,
      object: 'response',
      created_at: state.createdAt,
      status: 'in_progress',
      model: state.model,
      output: [],
    }
    emit(out, 'response.created', { response })
    emit(out, 'response.in_progress', { response })
  }

  const startMessage = (out) => {
    if (state.messageStarted) return
    state.messageStarted = true
    state.messageOutputIndex = state.nextOutputIndex
    state.nextOutputIndex += 1
    emit(out, 'response.output_item.added', {
      response_id: state.responseId,
      output_index: state.messageOutputIndex,
      item: {
        id: state.messageId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    })
    emit(out, 'response.content_part.added', {
      response_id: state.responseId,
      item_id: state.messageId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
  }

  const consume = (event) => {
    if (event.data === '[DONE]') {
      state.terminal = true
      return []
    }
    const payload = parseJson(event.data)
    if (!payload) return []
    const failure = upstreamSseFailureMessage(payload, event.event || payload.type || '')
    if (failure) throw makeWireStreamFailure(failure)

    const out = []
    ensureStarted(payload, out)
    state.usage = normalizeUsagePayload(payload.usage) || state.usage
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
    const delta = contentToText(choice?.delta?.content ?? '')
    if (delta) {
      startMessage(out)
      state.fullText += delta
      emit(out, 'response.output_text.delta', {
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        delta,
      })
    }

    for (const toolDelta of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
      const index = Number.isInteger(toolDelta?.index) ? toolDelta.index : state.toolCalls.size
      let call = state.toolCalls.get(index)
      if (!call) {
        const id = toolDelta?.id || `call_${state.responseId}_${index}`
        call = {
          id,
          callId: id,
          name: toolDelta?.function?.name || '',
          arguments: '',
          outputIndex: state.nextOutputIndex,
        }
        state.nextOutputIndex += 1
        state.toolCalls.set(index, call)
        emit(out, 'response.output_item.added', {
          response_id: state.responseId,
          output_index: call.outputIndex,
          item: {
            id: call.id,
            type: 'function_call',
            status: 'in_progress',
            call_id: call.callId,
            name: call.name,
            arguments: '',
          },
        })
      }
      if (toolDelta?.id) {
        call.id = toolDelta.id
        call.callId = toolDelta.id
      }
      if (toolDelta?.function?.name) call.name = toolDelta.function.name
      const argumentDelta = typeof toolDelta?.function?.arguments === 'string'
        ? toolDelta.function.arguments
        : ''
      if (argumentDelta) {
        call.arguments += argumentDelta
        emit(out, 'response.function_call_arguments.delta', {
          response_id: state.responseId,
          item_id: call.id,
          output_index: call.outputIndex,
          delta: argumentDelta,
        })
      }
    }

    if (choice?.finish_reason) state.terminal = true
    return out
  }

  const complete = () => {
    if (!state.started || !state.terminal || state.completedEmitted) return []
    state.completedEmitted = true
    const out = []
    if (state.messageStarted) {
      const message = {
        id: state.messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: state.fullText, annotations: [] }],
      }
      emit(out, 'response.output_text.done', {
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        text: state.fullText,
      })
      emit(out, 'response.content_part.done', {
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        part: message.content[0],
      })
      emit(out, 'response.output_item.done', {
        response_id: state.responseId,
        output_index: state.messageOutputIndex,
        item: message,
      })
      state.outputIndexes.set(message.id, state.messageOutputIndex)
      state.output.push(message)
    }

    for (const call of [...state.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      const item = {
        id: call.id,
        type: 'function_call',
        status: 'completed',
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      }
      emit(out, 'response.function_call_arguments.done', {
        response_id: state.responseId,
        item_id: call.id,
        output_index: call.outputIndex,
        name: call.name,
        arguments: call.arguments,
      })
      emit(out, 'response.output_item.done', {
        response_id: state.responseId,
        output_index: call.outputIndex,
        item,
      })
      state.outputIndexes.set(item.id, call.outputIndex)
      state.output.push(item)
    }

    state.output.sort((a, b) => (state.outputIndexes.get(a.id) ?? 0) - (state.outputIndexes.get(b.id) ?? 0))
    emit(out, 'response.completed', {
      response: {
        id: state.responseId,
        object: 'response',
        created_at: state.createdAt,
        status: 'completed',
        model: state.model,
        output: state.output,
        output_text: state.fullText,
        usage: state.usage ? internalUsageToResponsesUsage(state.usage) : undefined,
      },
    })
    return out
  }

  return {
    ingest(chunk) {
      return parser.push(chunk).flatMap(consume)
    },
    finish() {
      const out = parser.finish().flatMap(consume)
      return [...out, ...complete()]
    },
    usage() {
      return state.usage
    },
    responseId() {
      return state.responseId
    },
  }
}

function createSseParser() {
  const decoder = new TextDecoder()
  let buffer = ''
  let current = emptySseEvent()

  const flushEvent = (out) => {
    if (!current.event && !current.id && current.data.length === 0) return
    out.push({ event: current.event, id: current.id, data: current.data.join('\n') })
    current = emptySseEvent()
  }

  const readLine = (line, out) => {
    if (line === '') {
      flushEvent(out)
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    let value = separator >= 0 ? line.slice(separator + 1) : ''
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') current.event = value
    if (field === 'data') current.data.push(value)
    if (field === 'id') current.id = value
  }

  const consumeText = (text, finish = false) => {
    buffer += text
    const out = []
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      readLine(line, out)
      newline = buffer.indexOf('\n')
    }
    if (finish) {
      if (buffer) {
        let line = buffer
        buffer = ''
        if (line.endsWith('\r')) line = line.slice(0, -1)
        readLine(line, out)
      }
      flushEvent(out)
    }
    return out
  }

  return {
    push(chunk) {
      return consumeText(decoder.decode(chunk, { stream: true }))
    },
    finish() {
      return consumeText(decoder.decode(), true)
    },
  }
}

function emptySseEvent() {
  return { event: '', id: '', data: [] }
}

function responseIdFromPayload(payload) {
  return textFrom(payload?.response_id, payload?.response?.id, payload?.id)
}

function streamModelFromPayload(payload) {
  return textFrom(payload?.model, payload?.response?.model)
}

function streamCreatedAtFromPayload(payload, fallback) {
  const value = Number(payload?.created ?? payload?.created_at ?? payload?.response?.created_at)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function textFrom(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function isResponsesTerminal(payload, type) {
  return type === 'response.completed' ||
    payload?.response?.status === 'completed' ||
    type === 'response.output_text.done' ||
    type === 'response.refusal.done'
}

function upstreamSseFailureMessage(payload, type) {
  if (type === 'response.failed' || type === 'error' || payload?.response?.status === 'failed' || payload?.response?.status === 'error' || payload?.error) {
    return errorText(payload?.error ?? payload?.response?.error ?? payload?.response?.message ?? payload?.message ?? payload?.detail) || 'Upstream reported a stream failure.'
  }
  return ''
}

function errorText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message.trim()) return value.message.trim()
    if (typeof value.detail === 'string' && value.detail.trim()) return value.detail.trim()
    try {
      return JSON.stringify(value)
    } catch {}
  }
  return ''
}

function makeWireStreamFailure(message) {
  const error = new Error(`Upstream stream failed before completion: ${message}`)
  error.code = 'UPSTREAM_STREAM_FAILED'
  return error
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

function responsesToolToChatTool(tool) {
  if (!tool || typeof tool !== 'object' || tool.type !== 'function' || !tool.name) return null
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {} },
      ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
    },
  }
}

function responsesToolChoiceToChat(toolChoice) {
  if (typeof toolChoice === 'string') return toolChoice
  if (toolChoice?.type === 'function' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return toolChoice
}

function toolOutputToText(output) {
  if (typeof output === 'string') return output
  if (output == null) return ''
  if (Array.isArray(output)) return contentToText(output)
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
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
    prompt_tokens_details: usage.cachedTokensReported || usage.cachedTokens
      ? { cached_tokens: usage.cachedTokens }
      : undefined,
  }
}

function internalUsageToResponsesUsage(usage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: usage.cachedTokensReported || usage.cachedTokens
      ? { cached_tokens: usage.cachedTokens }
      : undefined,
    cache_read_input_tokens: usage.cachedTokensReported || usage.cachedTokens
      ? usage.cachedTokens
      : undefined,
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return toTokenCount(
      value.totalTokens ??
      value.total_tokens ??
      value.tokens ??
      value.value,
    )
  }
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}
