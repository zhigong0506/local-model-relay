import { buildCandidates } from './proxy.mjs'
import { resolveActiveKey } from './config-store.mjs'
import { getCachedSystemProxy, resolveProviderOutboundProxy } from './outbound-proxy.mjs'
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
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs || 30000)

  try {
    const response = await upstreamFetch(buildModelsUrl(provider.baseUrl), {
      method: 'GET',
      headers: buildAuthHeaders(provider),
      signal: controller.signal,
      proxyUrl: resolveProviderProxy(provider, serviceConfig).proxyUrl,
    })
    const models = response.ok ? await readModels(response) : []

    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      model: selectedModel,
      models,
      message: response.ok
        ? `Provider responded to /v1/models. ${models.length} model(s) found.`
        : await safeText(response),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      model: selectedModel,
      models: [],
      message: error instanceof Error ? error.message : String(error),
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
  const selectedModel = normalizeText(input.model) || preferredRealTestModel(provider)
  const prompt = normalizeText(input.prompt) || 'Reply with exactly: OK'
  const maxTokens = clampInteger(input.maxTokens, 1, 128, 8)
  const startedAt = Date.now()
  const wireApi = normalizeWireApi(input.wireApi) || provider.wireApi || 'chat'

  const first = await sendChatCompletion(testProvider, selectedModel, prompt, maxTokens, 'max_tokens', wireApi, serviceConfig)
  if (!first.ok && /max_tokens|max_completion_tokens/i.test(first.message || '')) {
    const retry = await sendChatCompletion(testProvider, selectedModel, prompt, maxTokens, 'max_completion_tokens', wireApi, serviceConfig)
    return {
      ...retry,
      credentialId: selectedCredential?.id || provider.activeCredentialId || '',
      credentialLabel: selectedCredential?.label || '',
      wireApi,
      model: selectedModel,
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
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs || 30000)

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
      snapshot,
      message: response.ok && hasSnapshotData ? 'ok' : preview(text || 'No upstream usage fields were returned.'),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      credentialId: selectedCredential.id,
      credentialLabel: selectedCredential.label || '',
      latencyMs: Date.now() - startedAt,
      snapshot: null,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function sendChatCompletion(provider, model, prompt, maxTokens, tokenField, wireApi, serviceConfig) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs || 30000)

  try {
    const requestUrl = '/v1/chat/completions'
    const plan = buildWirePlan(requestUrl, { ...provider, wireApi })
    const body = buildWireBody({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      stream: false,
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
    const text = await response.text()
    const payload = parseJson(text)
    const transformedPayload = payload ? transformResponsePayload(payload, plan) : null
    const content = readCompletionText(transformedPayload)

    return {
      ok: response.ok,
      status: response.status,
      content,
      usage: normalizeUsagePayload(transformedPayload?.usage),
      rawUsage: transformedPayload?.usage || null,
      message: response.ok ? 'ok' : preview(text || `HTTP ${response.status}`),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      content: '',
      usage: null,
      rawUsage: null,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
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
  if (provider.authMode === 'authorization' || provider.authMode === 'both') {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  if (provider.authMode === 'x-api-key' || provider.authMode === 'both') {
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
    credentials[0] ||
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

function preferredRealTestModel(provider) {
  const models = Array.isArray(provider.models) ? provider.models : []
  return models.find((model) => /mini|flash|lite|small/i.test(model)) || models[0] || 'gpt-4o-mini'
}

function preview(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

async function readModels(response) {
  try {
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) return []
    return [...new Set(payload.data
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean))]
      .sort()
  } catch {
    return []
  }
}
