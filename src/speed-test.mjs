import { getCachedSystemProxy, resolveProviderOutboundProxy } from './outbound-proxy.mjs'
import { upstreamFetch } from './upstream-fetch.mjs'
import { normalizeUsagePayload } from './wire-api.mjs'
import { hasCompletionPayload, upstreamErrorMessage } from './response-validation.mjs'

const DEFAULT_PROMPT = 'Reply with exactly: OK'

export async function fetchSpeedTestModels(input = {}, serviceConfig = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const apiKey = normalizeText(input.apiKey)
  const startedAt = Date.now()
  if (!baseUrl) return { ok: false, status: 0, latencyMs: 0, models: [], message: 'Base URL 无效。' }
  if (!apiKey) return { ok: false, status: 0, latencyMs: 0, models: [], message: '请填写 API Key。' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), clampInteger(input.timeoutMs, 3000, 120000, 15000))

  try {
    const response = await upstreamFetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: controller.signal,
      proxyUrl: resolveSpeedProxy(input, serviceConfig),
    })
    const text = await response.text()
    const payload = parseJson(text)
    const models = Array.isArray(payload?.data)
      ? [...new Set(payload.data.map((item) => normalizeText(item?.id)).filter(Boolean))].sort()
      : []
    const errorMessage = upstreamErrorMessage(payload)
    const valid = Boolean(payload && Array.isArray(payload.data) && !errorMessage)
    return {
      ok: response.ok && valid,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      models,
      message: response.ok && valid
        ? `发现 ${models.length} 个模型。`
        : errorMessage || preview(text || `HTTP ${response.status}`),
    }
  } catch (error) {
    return speedErrorResult(error, controller.signal.aborted, Date.now() - startedAt, input.timeoutMs)
  } finally {
    clearTimeout(timeout)
  }
}

export async function runSpeedTest(input = {}, serviceConfig = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const apiKey = normalizeText(input.apiKey)
  const model = normalizeText(input.model)
  const rounds = clampInteger(input.rounds, 1, 10, 3)
  const maxTokens = clampInteger(input.maxTokens, 1, 1024, 64)
  const timeoutMs = clampInteger(input.timeoutMs, 3000, 180000, 60000)
  const wireApi = normalizeWireApi(input.wireApi)
  const prompt = normalizeText(input.prompt) || DEFAULT_PROMPT

  if (!baseUrl) return { ok: false, message: 'Base URL 无效。', rounds: [] }
  if (!apiKey) return { ok: false, message: '请填写 API Key。', rounds: [] }
  if (!model) return { ok: false, message: '请选择或填写模型。', rounds: [] }

  const results = []
  for (let index = 0; index < rounds; index += 1) {
    results.push(await runOneRound({
      baseUrl,
      apiKey,
      model,
      wireApi,
      prompt,
      maxTokens,
      timeoutMs,
      proxyUrl: resolveSpeedProxy(input, serviceConfig),
      round: index + 1,
    }))
  }

  const successes = results.filter((item) => item.ok)
  return {
    ok: successes.length === results.length,
    partialOk: successes.length > 0,
    model,
    wireApi,
    rounds: results,
    summary: summarizeRounds(successes),
    message: successes.length
      ? `${successes.length}/${results.length} 轮成功。`
      : results[0]?.message || '测速失败。',
  }
}

async function runOneRound(detail) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), detail.timeoutMs)
  const startedAt = Date.now()

  try {
    const url = detail.wireApi === 'responses'
      ? `${detail.baseUrl}/responses`
      : `${detail.baseUrl}/chat/completions`
    const response = await upstreamFetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(detail.apiKey),
        'content-type': 'application/json',
      },
      body: JSON.stringify(speedBody(detail)),
      signal: controller.signal,
      proxyUrl: detail.proxyUrl,
    })
    const headerMs = Date.now() - startedAt
    const contentType = response.headers.get('content-type') || ''
    const parsed = contentType.includes('text/event-stream')
      ? await readSseResponse(response, detail.wireApi, startedAt)
      : await readJsonResponse(response, detail.wireApi, startedAt)
    const totalMs = Date.now() - startedAt
    const generationMs = parsed.firstTokenMs === null ? totalMs : Math.max(1, totalMs - parsed.firstTokenMs)
    const outputTokens = Number(parsed.usage?.outputTokens || 0) || estimateTokens(parsed.text)
    const errorMessage = parsed.errorText || ''
    const ok = response.ok && !errorMessage && parsed.hasCompletion
    return {
      round: detail.round,
      ok,
      status: response.status,
      headerMs,
      firstTokenMs: parsed.firstTokenMs,
      totalMs,
      generationMs,
      outputTokens,
      tokensPerSecond: outputTokens ? Number((outputTokens / (generationMs / 1000)).toFixed(2)) : 0,
      chars: parsed.text.length,
      usage: parsed.usage,
      content: preview(parsed.text, 240),
      message: ok ? 'ok' : preview(errorMessage || `HTTP ${response.status}`),
    }
  } catch (error) {
    return {
      ...speedErrorResult(error, controller.signal.aborted, Date.now() - startedAt, detail.timeoutMs),
      round: detail.round,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function speedBody(detail) {
  if (detail.wireApi === 'responses') {
    return {
      model: detail.model,
      input: detail.prompt,
      stream: true,
      max_output_tokens: detail.maxTokens,
    }
  }

  return {
    model: detail.model,
    messages: [{ role: 'user', content: detail.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: detail.maxTokens,
    temperature: 0,
  }
}

async function readSseResponse(response, wireApi, startedAt) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let usage = null
  let errorText = ''
  let firstTokenMs = null
  let hasCompletion = false

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const payload = parseJson(data)
      if (!payload) continue
      const delta = extractTextDelta(payload, wireApi)
      if (delta) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt
        text += delta
      }
      usage = normalizeUsagePayload(payload?.usage || payload?.response?.usage) || usage
      errorText ||= upstreamErrorMessage(payload)
      if (wireApi === 'responses' && hasCompletionPayload(payload, wireApi)) hasCompletion = true
      if (wireApi !== 'responses' && Array.isArray(payload.choices) && payload.choices.length > 0) hasCompletion = true
    }
  }

  if (buffer) {
    const payload = parseJson(buffer.replace(/^data:\s*/, ''))
    usage = normalizeUsagePayload(payload?.usage || payload?.response?.usage) || usage
    errorText ||= upstreamErrorMessage(payload)
    if (wireApi === 'responses' && hasCompletionPayload(payload, wireApi)) hasCompletion = true
    if (wireApi !== 'responses' && Array.isArray(payload?.choices) && payload.choices.length > 0) hasCompletion = true
  }

  return { text, usage, errorText, firstTokenMs, hasCompletion: hasCompletion || Boolean(text) }
}

async function readJsonResponse(response, wireApi, startedAt) {
  const text = await response.text()
  const payload = parseJson(text)
  if (!payload) return { text: '', usage: null, errorText: text, firstTokenMs: null, hasCompletion: false }
  const content = extractResponseText(payload, wireApi)
  return {
    text: content,
    usage: normalizeUsagePayload(payload?.usage || payload?.response?.usage),
    errorText: upstreamErrorMessage(payload) || '',
    firstTokenMs: content ? Date.now() - startedAt : null,
    hasCompletion: hasCompletionPayload(payload, wireApi),
  }
}

function extractTextDelta(payload, wireApi) {
  if (wireApi === 'responses') {
    if (typeof payload.delta === 'string' && payload.type === 'response.output_text.delta') return payload.delta
    if (typeof payload.text === 'string') return payload.text
    return ''
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
  return typeof choice?.delta?.content === 'string' ? choice.delta.content : ''
}

function extractResponseText(payload, wireApi) {
  if (wireApi === 'responses') {
    if (typeof payload.output_text === 'string') return payload.output_text
    if (Array.isArray(payload.output)) {
      return payload.output
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .map((part) => typeof part?.text === 'string' ? part.text : '')
        .join('')
    }
    return ''
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
  return typeof choice?.message?.content === 'string' ? choice.message.content : ''
}

function summarizeRounds(rounds) {
  if (!rounds.length) return null
  return {
    successCount: rounds.length,
    avgFirstTokenMs: average(rounds.map((item) => item.firstTokenMs).filter((value) => Number.isFinite(value))),
    avgTotalMs: average(rounds.map((item) => item.totalMs)),
    avgTokensPerSecond: average(rounds.map((item) => item.tokensPerSecond).filter((value) => value > 0)),
    bestTotalMs: Math.min(...rounds.map((item) => item.totalMs)),
    worstTotalMs: Math.max(...rounds.map((item) => item.totalMs)),
  }
}

function average(values) {
  if (!values.length) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function resolveSpeedProxy(input = {}, serviceConfig = {}) {
  const mode = normalizeText(input.proxyMode) || 'inherit'
  const provider = {
    outboundProxyMode: ['direct', 'system', 'custom'].includes(mode) ? mode : 'inherit',
    outboundProxyUrl: input.proxyUrl || '',
  }
  return resolveProviderOutboundProxy(provider, serviceConfig, {
    systemProxy: getCachedSystemProxy(),
  }).proxyUrl
}

function normalizeBaseUrl(value) {
  const raw = normalizeText(value).replace(/\/+$/, '')
  if (!raw) return ''
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    const path = url.pathname.replace(/\/+$/, '')
    url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` }
}

function normalizeWireApi(value) {
  return value === 'responses' ? 'responses' : 'chat'
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function preview(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || '').length / 4))
}

function speedErrorResult(error, timedOut, latencyMs, timeoutMs = 0) {
  return {
    ok: false,
    status: 0,
    latencyMs,
    models: [],
    message: timedOut
      ? `测速本地超时：${timeoutMs || latencyMs} ms 内没有收到完整响应。`
      : error instanceof Error ? error.message : String(error),
  }
}
