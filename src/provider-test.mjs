import { buildCandidates } from './proxy.mjs'
import { resolveActiveCredential, resolveActiveKey } from './config-store.mjs'
import { getCachedSystemProxy, resolveProviderOutboundProxy } from './outbound-proxy.mjs'
import { hasCompletionPayload, upstreamErrorMessage } from './response-validation.mjs'
import {
  buildWireBody,
  buildWirePlan,
  buildWireUrl,
  normalizeUsagePayload,
  transformResponsePayload,
} from './wire-api.mjs'
import { upstreamFetch } from './upstream-fetch.mjs'

export async function testProvider(provider, model = null, serviceConfig = {}) {
  const selectedModel = model || provider.models[0] || 'gpt-4o-mini'
  const activeCredential = resolveActiveCredential(provider)
  if (provider.authMode !== 'none' && !activeCredential) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      model: selectedModel,
      models: [],
      reason: 'no_credential',
      message: 'No enabled credential is available for this provider.',
    }
  }
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeoutMs = resolveTestTimeout(serviceConfig.providerTestTimeoutMs, 3000, 120000, 30000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await upstreamFetch(buildModelsUrl(provider.baseUrl), {
      method: 'GET',
      headers: buildAuthHeaders(provider),
      signal: controller.signal,
      proxyUrl: resolveProviderProxy(provider, serviceConfig).proxyUrl,
    })
    const parsed = response.ok ? await readModels(response) : { models: [], errorMessage: '' }
    const errorMessage = parsed.errorMessage
    const ok = response.ok && !errorMessage && parsed.valid

    return {
      ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      model: selectedModel,
      models: parsed.models,
      timeoutMs,
      message: ok
        ? `Provider responded to /v1/models. ${parsed.models.length} model(s) found.`
        : errorMessage || (response.ok ? 'Upstream returned an invalid /v1/models response.' : await safeText(response)),
    }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      model: selectedModel,
      models: [],
      timeoutMs,
      reason: timedOut ? 'local_timeout' : 'network_error',
      message: timedOut
        ? `Local connectivity test timed out after ${timeoutMs} ms before /v1/models responded.`
        : error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function realTestProvider(provider, input = {}, serviceConfig = {}) {
  const selectedCredential = selectCredential(provider, String(input.credentialId || ''))
  const testProvider = selectedCredential
    ? { ...provider, activeCredentialId: selectedCredential.id }
    : provider
  const availableModels = availableProviderModels(provider)
  const requestedModel = normalizeText(input.model)
  const selectedModel = requestedModel || preferredRealTestModel(availableModels)
  const prompt = normalizeText(input.prompt) || 'Reply with exactly: OK'
  const maxTokens = clampInteger(input.maxTokens, 1, 128, 8)
  const startedAt = Date.now()
  const wireApi = normalizeWireApi(input.wireApi) || provider.wireApi || 'chat'
  const timeoutMs = resolveTestTimeout(serviceConfig.providerRealTestTimeoutMs, 5000, 300000, 90000)

  if (provider.authMode !== 'none' && !selectedCredential) {
    return skippedRealTestResult({
      provider,
      selectedCredential,
      selectedModel,
      wireApi,
      reason: 'no_credential',
      message: 'No enabled credential is available for this provider.',
    })
  }

  if (!availableModels.length) {
    return skippedRealTestResult({
      provider,
      selectedCredential,
      selectedModel,
      wireApi,
      reason: 'no_supported_models',
      message: 'No supported models are configured for this provider.',
    })
  }

  if (!availableModels.includes(selectedModel)) {
    return skippedRealTestResult({
      provider,
      selectedCredential,
      selectedModel,
      wireApi,
      reason: 'unsupported_model',
      message: 'The selected model is not in this provider supported model list.',
    })
  }

  const first = await sendChatCompletion(
    testProvider,
    selectedModel,
    prompt,
    maxTokens,
    'max_tokens',
    wireApi,
    serviceConfig,
    timeoutMs,
  )
  if (!first.ok && /max_tokens|max_completion_tokens/i.test(first.message || '')) {
    const retry = await sendChatCompletion(
      testProvider,
      selectedModel,
      prompt,
      maxTokens,
      'max_completion_tokens',
      wireApi,
      serviceConfig,
      timeoutMs,
    )
    return {
      ...retry,
      credentialId: selectedCredential?.id || provider.activeCredentialId || '',
      credentialLabel: selectedCredential?.label || '',
      wireApi,
      model: selectedModel,
      timeoutMs,
      retriedWith: 'max_completion_tokens',
      latencyMs: Date.now() - startedAt,
    }
  }

  return {
    ...first,
    credentialId: selectedCredential?.id || provider.activeCredentialId || '',
    credentialLabel: selectedCredential?.label || '',
    wireApi,
    model: selectedModel,
    timeoutMs,
    latencyMs: Date.now() - startedAt,
  }
}

export async function syncProviderCredentialUsage(provider, input = {}, serviceConfig = {}) {
  const selectedCredential = selectCredential(provider, String(input.credentialId || ''))
  if (!selectedCredential) {
    return {
      ok: false,
      status: 0,
      credentialId: '',
      credentialLabel: '',
      message: 'No credential is available.',
    }
  }

  const testProvider = { ...provider, activeCredentialId: selectedCredential.id }
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeoutMs = resolveTestTimeout(serviceConfig.providerTestTimeoutMs, 3000, 120000, 30000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await upstreamFetch(buildUserSelfUrl(provider.baseUrl), {
      method: 'GET',
      headers: buildAuthHeaders(testProvider),
      signal: controller.signal,
      proxyUrl: resolveProviderProxy(testProvider, serviceConfig).proxyUrl,
    })
    const text = await response.text()
    const payload = parseJson(text)
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
    const snapshot = data && typeof data === 'object' ? {
      group: data.group,
      username: data.username ?? data.name ?? data.display_name,
      quota: data.quota ?? data.remain_quota ?? data.remaining_quota,
      used_quota: data.used_quota,
      request_count: data.request_count,
      status: data.status,
    } : null
    const hasSnapshotData = snapshot && Object.values(snapshot).some((value) => value !== undefined && value !== null && value !== '')

    return {
      ok: response.ok && hasSnapshotData,
      status: response.status,
      credentialId: selectedCredential.id,
      credentialLabel: selectedCredential.label || '',
      latencyMs: Date.now() - startedAt,
      timeoutMs,
      snapshot,
      message: response.ok && hasSnapshotData ? 'ok' : preview(text || 'No upstream usage fields were returned.'),
    }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return {
      ok: false,
      status: 0,
      credentialId: selectedCredential.id,
      credentialLabel: selectedCredential.label || '',
      latencyMs: Date.now() - startedAt,
      timeoutMs,
      snapshot: null,
      reason: timedOut ? 'local_timeout' : 'network_error',
      message: timedOut
        ? `Local usage sync timed out after ${timeoutMs} ms before the upstream response was received.`
        : error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function sendChatCompletion(provider, model, prompt, maxTokens, tokenField, wireApi, serviceConfig, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const requestUrl = '/v1/chat/completions'
    const plan = buildWirePlan(requestUrl, { ...provider, wireApi })
    const body = buildWireBody({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      stream: true,
      [tokenField]: maxTokens,
    }, { provider, model }, { collectUsage: false, collectStreamUsage: false }, plan)
    const headers = buildAuthHeaders(provider)
    headers.set('content-type', 'application/json')

    const response = await upstreamFetch(buildWireUrl(provider.baseUrl, requestUrl, plan), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      proxyUrl: resolveProviderProxy(provider, serviceConfig).proxyUrl,
    })
    const contentType = response.headers.get('content-type') || ''
    const parsed = contentType.includes('text/event-stream')
      ? await readStreamingCompletion(response, plan.upstreamApi)
      : await readJsonCompletion(response, plan)
    const errorMessage = parsed.errorMessage
    const ok = response.ok && !errorMessage && parsed.hasCompletion

    return {
      ok,
      status: response.status,
      content: parsed.content,
      usage: parsed.usage,
      rawUsage: parsed.rawUsage,
      message: ok ? 'ok' : errorMessage || preview(parsed.rawText || `HTTP ${response.status}`),
    }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return {
      ok: false,
      status: 0,
      content: '',
      usage: null,
      rawUsage: null,
      reason: timedOut ? 'local_timeout' : 'network_error',
      message: timedOut
        ? `Local real test timed out after ${timeoutMs} ms before the upstream response was received.`
        : error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readJsonCompletion(response, plan) {
  const rawText = await response.text()
  const payload = parseJson(rawText)
  const transformedPayload = payload ? transformResponsePayload(payload, plan) : null
  return {
    content: readCompletionText(transformedPayload),
    usage: normalizeUsagePayload(transformedPayload?.usage),
    rawUsage: transformedPayload?.usage || null,
    errorMessage: upstreamErrorMessage(payload) || upstreamErrorMessage(transformedPayload),
    hasCompletion: hasCompletionPayload(payload, plan.upstreamApi) || hasCompletionPayload(transformedPayload, plan.incomingApi),
    rawText,
  }
}

async function readStreamingCompletion(response, wireApi) {
  if (!response.body) {
    return {
      content: '',
      usage: null,
      rawUsage: null,
      errorMessage: 'Upstream returned an empty stream.',
      hasCompletion: false,
      rawText: '',
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage = null
  let errorMessage = ''
  let hasCompletion = false

  const consume = (data) => {
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') hasCompletion = true
      return
    }
    const payload = parseJson(data)
    if (!payload) return
    errorMessage ||= upstreamErrorMessage(payload)
    if (wireApi === 'responses') {
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') content += payload.delta
      else if (typeof payload.text === 'string') content += payload.text
      if (hasCompletionPayload(payload, wireApi)) hasCompletion = true
    } else {
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content
      if (Array.isArray(payload.choices) && payload.choices.length > 0) hasCompletion = true
    }
    usage = normalizeUsagePayload(payload.usage || payload.response?.usage) || usage
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) consume(trimmed.slice(5).trim())
    }
  }
  if (buffer.trim().startsWith('data:')) consume(buffer.trim().slice(5).trim())

  return {
    content,
    usage,
    rawUsage: usage,
    errorMessage,
    hasCompletion: hasCompletion || Boolean(content),
    rawText: content,
  }
}

function resolveTestTimeout(value, min, max, fallback) {
  return clampInteger(value, min, max, fallback)
}

function buildModelsUrl(baseUrl) {
  const parsedBase = new URL(baseUrl)
  const trimmedPath = parsedBase.pathname.replace(/\/+$/, '')
  const normalized = trimmedPath === '' ? `${parsedBase.origin}/v1` : baseUrl.replace(/\/+$/, '')
  return `${normalized}/models`
}

function resolveProviderProxy(provider, serviceConfig = {}) {
  return resolveProviderOutboundProxy(provider, serviceConfig, {
    systemProxy: getCachedSystemProxy(),
  })
}

function buildUserSelfUrl(baseUrl) {
  const parsedBase = new URL(baseUrl)
  return `${parsedBase.origin}/api/user/self`
}

export function previewRoute(config, stateStore, model) {
  const fakeRoute = config.routes.find((route) => route.enabled && route.virtualModel === model) || null
  return buildCandidates(config, fakeRoute, model, stateStore).map((candidate) => ({
    providerId: candidate.provider.id,
    providerName: candidate.provider.name,
    model: candidate.model,
    priority: candidate.provider.priority,
  }))
}

function buildAuthHeaders(provider) {
  const headers = new Headers()
  const apiKey = resolveActiveKey(provider)
  if (apiKey && (provider.authMode === 'authorization' || provider.authMode === 'both')) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  if (apiKey && (provider.authMode === 'x-api-key' || provider.authMode === 'both')) {
    headers.set('x-api-key', apiKey)
  }
  return headers
}

function selectCredential(provider, credentialId) {
  const credentials = Array.isArray(provider.credentials) ? provider.credentials : []
  return (
    credentials.find((credential) => credential.id === credentialId && credential.enabled) ||
    credentials.find((credential) => credential.id === provider.activeCredentialId && credential.enabled) ||
    credentials.find((credential) => credential.enabled) ||
    null
  )
}

async function safeText(response) {
  try {
    const text = await response.text()
    return text.replace(/\s+/g, ' ').trim().slice(0, 500) || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readCompletionText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
  if (typeof choice?.message?.content === 'string') return choice.message.content
  if (typeof choice?.text === 'string') return choice.text
  if (typeof payload.output_text === 'string') return payload.output_text
  if (Array.isArray(payload.output)) {
    return payload.output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .join('')
  }
  return ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeWireApi(value) {
  return value === 'responses' || value === 'chat' || value === 'auto' ? value : ''
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function preferredRealTestModel(models) {
  return models.find((model) => /mini|flash|lite|small/i.test(model)) || models[0] || ''
}

function availableProviderModels(provider) {
  return [...new Set((Array.isArray(provider.models) ? provider.models : [])
    .map((model) => String(model).trim())
    .filter(Boolean))]
}

function skippedRealTestResult({ provider, selectedCredential, selectedModel, wireApi, reason, message }) {
  return {
    ok: false,
    skipped: true,
    reason,
    status: 400,
    latencyMs: 0,
    model: selectedModel,
    credentialId: selectedCredential?.id || provider.activeCredentialId || '',
    credentialLabel: selectedCredential?.label || '',
    wireApi,
    content: '',
    usage: null,
    rawUsage: null,
    message,
  }
}

function preview(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

async function readModels(response) {
  try {
    const text = await response.text()
    const payload = parseJson(text)
    const errorMessage = upstreamErrorMessage(payload)
    if (!payload || !Array.isArray(payload.data)) {
      return { models: [], valid: false, errorMessage: errorMessage || preview(text || 'Invalid /v1/models response.') }
    }
    const models = [...new Set(payload.data
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean))]
      .sort()
    return { models, valid: true, errorMessage }
  } catch {
    return { models: [], valid: false, errorMessage: 'Invalid JSON returned by /v1/models.' }
  }
}
