import { resolveActiveCredential, resolveActiveKey } from './config-store.mjs'
import { getCachedSystemProxy, resolveProviderOutboundProxy } from './outbound-proxy.mjs'
import {
  buildWireBody,
  buildWirePlan,
  buildWireUrl,
  normalizeUsagePayload,
  transformWireResponse,
} from './wire-api.mjs'
import { upstreamFetch } from './upstream-fetch.mjs'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024
const MAX_USAGE_SNIFF_BYTES = 10 * 1024 * 1024
const CLIENT_ABORTED_CODE = 'CLIENT_ABORTED'
const APPROX_CHARS_PER_TOKEN = 4

export async function handleProxyRequest(req, res, context) {
  const { configStore, stateStore } = context
  const config = configStore.get()
  const startedAt = Date.now()

  if (!config.service.enabled) {
    return sendJson(res, 503, {
      error: {
        type: 'service_disabled',
        message: 'Local relay is disabled.',
      },
    })
  }

  if (!isAuthorized(req.headers, config.service.localApiKey)) {
    return sendJson(res, 401, {
      error: {
        type: 'authentication_error',
        message: 'Invalid local relay API key.',
      },
    })
  }

  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    return sendJson(res, 200, {
      object: 'list',
      data: listModels(config).map((model) => ({
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'local-model-relay',
      })),
    })
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, {
      error: {
        type: 'method_not_allowed',
        message: 'Only POST requests are proxied under /v1, except GET /v1/models.',
      },
    })
  }

  let body
  try {
    body = JSON.parse(await readRequestBody(req))
  } catch (error) {
    return sendJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
      error: {
        type: error?.code === 'BODY_TOO_LARGE' ? 'request_too_large' : 'invalid_request_error',
        message: error?.code === 'BODY_TOO_LARGE'
          ? 'Request body is too large.'
          : 'Request body must be valid JSON.',
      },
    })
  }

  const virtualModel = typeof body.model === 'string' ? body.model : ''
  const route = findRoute(config, virtualModel)
  const candidates = buildCandidates(config, route, virtualModel, stateStore)
  const attempts = []
  let lastError = null

  if (candidates.length === 0) {
    addRequestLog(config, stateStore, {
      method: req.method,
      path: req.url,
      model: virtualModel,
      status: 503,
      ok: false,
      attempts: [],
      durationMs: Date.now() - startedAt,
      error: 'No available provider route.',
    })
    return sendJson(res, 503, {
      error: {
        type: 'no_available_provider',
        message: `No available provider route for model "${virtualModel || '(missing)'}".`,
      },
    })
  }

  for (const candidate of candidates.slice(0, config.service.maxAttempts)) {
      const attempt = {
        providerId: candidate.provider.id,
        providerName: candidate.provider.name,
        credentialId: resolveActiveCredential(candidate.provider)?.id || '',
        credentialLabel: resolveActiveCredential(candidate.provider)?.label || '',
        model: candidate.model,
        startedAt: Date.now(),
      }
    attempts.push(attempt)
    stateStore.markAttempt(candidate.provider.id)

    try {
      const upstream = await callUpstream(req, body, candidate, config.service)
      const upstreamResponse = upstream.response
      const latencyMs = Date.now() - attempt.startedAt
      attempt.status = upstreamResponse.status
      attempt.latencyMs = latencyMs
      let capturedUsage = null

      if (shouldRetryStatus(upstreamResponse.status, config.service.retryStatusCodes)) {
        const message = await readPreview(upstreamResponse)
        attempt.error = message
        stateStore.markFailure(candidate.provider.id, {
          status: upstreamResponse.status,
          message,
          latencyMs,
          cooldownSeconds: candidate.provider.cooldownSeconds,
        })
        lastError = { status: upstreamResponse.status, message }
        continue
      }

      const ok = upstreamResponse.status < 400
      try {
        capturedUsage = await pipeUpstreamResponse(upstreamResponse, res, candidate, attempts.length, upstream.abort, {
          collectUsage: config.service.collectUsage,
          requestBody: body,
          wirePlan: upstream.wirePlan,
        })
      } catch (streamError) {
        upstream.abort()
        const message = streamError instanceof Error ? streamError.message : String(streamError)
        capturedUsage = capturedUsage || streamError?.usage || null
        attempt.error = message

        if (streamError?.code === CLIENT_ABORTED_CODE) {
          if (capturedUsage) {
            stateStore.recordUsage(candidate.provider.id, candidate.model, capturedUsage, {
              credentialId: attempt.credentialId,
              latencyMs: Date.now() - attempt.startedAt,
            })
          }
          addRequestLog(config, stateStore, {
            method: req.method,
            path: req.url,
            model: virtualModel,
            routedModel: candidate.model,
            providerName: candidate.provider.name,
            status: upstreamResponse.status,
            ok: false,
            attempts: attempts.map(publicAttempt),
            durationMs: Date.now() - startedAt,
            error: message,
            usage: capturedUsage,
          })
          return
        }

        stateStore.markFailure(candidate.provider.id, {
          status: upstreamResponse.status || 0,
          message,
          latencyMs: Date.now() - attempt.startedAt,
          cooldownSeconds: ok ? candidate.provider.cooldownSeconds : 0,
        })

        addRequestLog(config, stateStore, {
          method: req.method,
          path: req.url,
          model: virtualModel,
          routedModel: candidate.model,
          providerName: candidate.provider.name,
          status: upstreamResponse.status || 0,
          ok: false,
          attempts: attempts.map(publicAttempt),
          durationMs: Date.now() - startedAt,
          error: message,
          usage: capturedUsage,
        })

        if (res.headersSent || res.writableEnded || res.destroyed) {
          if (!res.destroyed) res.destroy(streamError)
          return
        }

        clearResponseHeaders(res)
        lastError = { status: 0, message }
        continue
      }

      if (ok) {
        stateStore.markSuccess(candidate.provider.id, {
          status: upstreamResponse.status,
          latencyMs,
        })
        stateStore.advanceStartProvider?.(candidate.provider.id)
        if (capturedUsage) {
          stateStore.recordUsage(candidate.provider.id, candidate.model, capturedUsage, {
            credentialId: attempt.credentialId,
            latencyMs,
          })
        }
      } else {
        stateStore.markFailure(candidate.provider.id, {
          status: upstreamResponse.status,
          message: `HTTP ${upstreamResponse.status}`,
          latencyMs,
          cooldownSeconds: 0,
        })
      }
      addRequestLog(config, stateStore, {
        method: req.method,
        path: req.url,
        model: virtualModel,
        routedModel: candidate.model,
        providerName: candidate.provider.name,
        status: upstreamResponse.status,
        ok,
        attempts: attempts.map(publicAttempt),
        durationMs: Date.now() - startedAt,
        usage: ok ? capturedUsage : null,
      })
      return
    } catch (error) {
      const latencyMs = Date.now() - attempt.startedAt
      const message = error instanceof Error ? error.message : String(error)
      attempt.status = 0
      attempt.latencyMs = latencyMs
      attempt.error = message
      stateStore.markFailure(candidate.provider.id, {
        status: 0,
        message,
        latencyMs,
        cooldownSeconds: candidate.provider.cooldownSeconds,
      })
      lastError = { status: 0, message }
    }
  }

  addRequestLog(config, stateStore, {
    method: req.method,
    path: req.url,
    model: virtualModel,
    status: lastError?.status || 502,
    ok: false,
    attempts: attempts.map(publicAttempt),
    durationMs: Date.now() - startedAt,
    error: lastError?.message || 'Every provider failed.',
  })

  return sendJson(res, lastError?.status && lastError.status >= 400 ? lastError.status : 502, {
    error: {
      type: 'all_providers_failed',
      message: lastError?.message || 'Every provider failed.',
    },
    attempts: attempts.map(publicAttempt),
  })
}

function addRequestLog(config, stateStore, entry) {
  if (config.service.logRequests) stateStore.addRequestLog(entry, config.service.requestLogLimit)
}

export function findRoute(config, virtualModel) {
  if (!virtualModel) return null
  return config.routes.find((route) => route.enabled && route.virtualModel === virtualModel) || null
}

export function buildCandidates(config, route, virtualModel, stateStore) {
  const enabledProviders = new Map(
    config.providers
      .filter((provider) => provider.enabled)
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
      .map((provider) => [provider.id, provider]),
  )

  const now = Date.now()
  const candidates = []

  if (route) {
    for (const target of [...route.targets].sort((a, b) => a.priority - b.priority)) {
      const provider = enabledProviders.get(target.providerId)
      if (!provider || stateStore.isCooling(provider.id, now)) continue
      candidates.push({ provider, model: target.model })
    }
    return rotateToStart(candidates, stateStore.getStartProviderId?.())
  }

  for (const provider of enabledProviders.values()) {
    if (stateStore.isCooling(provider.id, now)) continue
    if (provider.models.length > 0 && !provider.models.includes(virtualModel)) continue
    candidates.push({ provider, model: virtualModel })
  }

  return rotateToStart(candidates, stateStore.getStartProviderId?.())
}

function rotateToStart(candidates, startProviderId = '') {
  if (!startProviderId || candidates.length < 2) return candidates
  const index = candidates.findIndex((candidate) => candidate.provider.id === startProviderId)
  if (index <= 0) return candidates
  return [...candidates.slice(index), ...candidates.slice(0, index)]
}

async function callUpstream(req, body, candidate, serviceConfig) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), candidate.provider.timeoutMs)
  const wirePlan = buildWirePlan(req.url, candidate.provider)
  const upstreamUrl = buildWireUrl(candidate.provider.baseUrl, req.url, wirePlan)
  const upstreamBody = buildWireBody(body, candidate, serviceConfig, wirePlan)

  try {
    const response = await upstreamFetch(upstreamUrl, {
      method: req.method,
      headers: buildHeaders(req.headers, candidate.provider),
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
      proxyUrl: resolveProviderOutboundProxy(candidate.provider, serviceConfig, {
        systemProxy: getCachedSystemProxy(),
      }).proxyUrl,
    })
    clearTimeout(timeout)
    return {
      response,
      wirePlan,
      abort: () => controller.abort(),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function buildHeaders(source, provider) {
  const headers = new Headers()
  const apiKey = resolveActiveKey(provider)

  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'authorization' || lower === 'x-api-key') continue
    if (Array.isArray(value)) {
      headers.set(name, value.join(', '))
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }

  headers.set('content-type', 'application/json')

  if (provider.authMode === 'authorization' || provider.authMode === 'both') {
    headers.set('authorization', `Bearer ${apiKey}`)
  }

  if (provider.authMode === 'x-api-key' || provider.authMode === 'both') {
    headers.set('x-api-key', apiKey)
  }

  return headers
}

async function readPreview(response) {
  const contentType = response.headers.get('content-type') || ''
  let text = ''

  try {
    text = await response.text()
  } catch {
    return `HTTP ${response.status}`
  }

  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return `HTTP ${response.status}`
  if (contentType.includes('text/event-stream')) {
    const match = trimmed.match(/data:\s*(\{.*?\})(?:\s|$)/)
    return match ? preview(match[1]) : preview(trimmed)
  }
  return preview(trimmed)
}

async function pipeUpstreamResponse(upstreamResponse, res, candidate, attemptsCount, abortUpstream, options = {}) {
  res.statusCode = upstreamResponse.status
  res.statusMessage = upstreamResponse.statusText

  for (const [name, value] of upstreamResponse.headers.entries()) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-encoding') continue
    res.setHeader(name, value)
  }

  res.setHeader('x-local-relay-provider', encodeURIComponent(candidate.provider.name))
  res.setHeader('x-local-relay-model', encodeURIComponent(candidate.model))
  res.setHeader('x-local-relay-attempts', String(attemptsCount))

  if (options.wirePlan?.transform) {
    return transformWireResponse(upstreamResponse, res, options.wirePlan)
  }

  if (!upstreamResponse.body) {
    res.end()
    return null
  }

  const usageCollector = createUsageCollector(upstreamResponse, options.collectUsage, options.requestBody)
  const clientAbort = new AbortController()
  let clientDisconnected = false
  const onClientClose = () => {
    if (res.writableEnded) return
    clientDisconnected = true
    abortUpstream?.()
    clientAbort.abort(makeClientAbortedError(usageCollector.usage || usageCollector.estimate()))
  }

  res.once('close', onClientClose)

  try {
    await upstreamResponse.body.pipeTo(new WritableStream({
      write(chunk) {
        usageCollector.ingest(chunk)
        return writeResponseChunk(res, chunk)
      },
      close() {
        usageCollector.finish()
        if (!res.writableEnded) res.end()
      },
      abort(error) {
        if (!res.destroyed) res.destroy(error)
      },
    }), { signal: clientAbort.signal })
  } catch (error) {
    if (clientDisconnected || error?.code === CLIENT_ABORTED_CODE) {
      throw makeClientAbortedError(usageCollector.usage || usageCollector.estimate())
    }
    throw error
  } finally {
    res.off('close', onClientClose)
  }

  return usageCollector.usage
}

function createUsageCollector(response, enabled, requestBody = {}) {
  const collector = {
    usage: null,
    ingest() {},
    finish() {},
    estimate() {
      return null
    },
  }

  if (!enabled) return collector

  const contentType = response.headers.get('content-type') || ''
  const isStream = contentType.includes('text/event-stream')
  let buffer = ''
  let totalBytes = 0
  let outputCharCount = 0
  let disabled = false
  const inputTokens = estimateInputTokens(requestBody)

  collector.estimate = () => {
    const outputTokens = estimateTokensFromChars(outputCharCount)
    if (!inputTokens && !outputTokens) return null
    return {
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
      estimated: true,
      estimateReason: 'no_upstream_usage',
    }
  }

  collector.ingest = (chunk) => {
    if (disabled || collector.usage) return
    const bytes = chunk.byteLength ?? chunk.length ?? 0
    totalBytes += bytes
    if (totalBytes > MAX_USAGE_SNIFF_BYTES) {
      disabled = true
      buffer = ''
      return
    }

    try {
      buffer += Buffer.from(chunk).toString('utf8')
      if (isStream) {
        const lastNewline = buffer.lastIndexOf('\n')
        if (lastNewline < 0) return
        const ready = buffer.slice(0, lastNewline + 1)
        buffer = buffer.slice(lastNewline + 1)
        outputCharCount += estimateSseOutputChars(ready)
        collector.usage = collector.usage || extractStreamUsage(ready)
      }
    } catch {
      disabled = true
      buffer = ''
    }
  }

  collector.finish = () => {
    if (disabled || collector.usage) return
    try {
      if (isStream) {
        outputCharCount += estimateSseOutputChars(buffer)
        collector.usage = extractStreamUsage(buffer)
      } else {
        const payload = JSON.parse(buffer)
        collector.usage = normalizeUsagePayload(payload?.usage)
        if (!collector.usage) outputCharCount += estimatePayloadOutputChars(payload)
      }
      collector.usage = collector.usage || collector.estimate()
    } catch {
      outputCharCount += buffer.length
      collector.usage = collector.estimate()
    }
  }

  return collector
}

function extractStreamUsage(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]' || !data.includes('"usage"')) continue
    const usage = extractJsonUsage(data)
    if (usage) return usage
  }
  return null
}

function extractJsonUsage(text) {
  const payload = JSON.parse(text)
  return normalizeUsagePayload(payload?.usage)
}

function estimateInputTokens(body = {}) {
  let chars = 0
  chars += contentLength(body.instructions)
  chars += contentLength(body.input)
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) chars += contentLength(message?.content)
  }
  return estimateTokensFromChars(chars)
}

function estimatePayloadOutputChars(payload) {
  let chars = 0
  if (Array.isArray(payload?.choices)) {
    for (const choice of payload.choices) {
      chars += contentLength(choice?.message?.content)
      chars += contentLength(choice?.delta?.content)
      chars += contentLength(choice?.text)
    }
  }
  chars += contentLength(payload?.output_text)
  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      chars += contentLength(item?.content)
      chars += contentLength(item?.text)
    }
  }
  return chars
}

function estimateSseOutputChars(text) {
  let chars = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]' || !data.startsWith('{')) continue
    try {
      chars += estimatePayloadOutputChars(JSON.parse(data))
    } catch {}
  }
  return chars
}

function contentLength(value) {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentLength(item), 0)
  if (!value || typeof value !== 'object') return 0
  let chars = 0
  if (typeof value.text === 'string') chars += value.text.length
  if (typeof value.content === 'string') chars += value.content.length
  if (Array.isArray(value.content)) chars += contentLength(value.content)
  return chars
}

function estimateTokensFromChars(chars) {
  const count = Number(chars || 0)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.max(1, Math.ceil(count / APPROX_CHARS_PER_TOKEN))
}

function writeResponseChunk(res, chunk) {
  if (res.destroyed) throw makeClientAbortedError()
  const buffer = Buffer.from(chunk)
  if (res.write(buffer)) return undefined

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('error', onError)
      res.off('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(makeClientAbortedError())
    }
    res.once('drain', onDrain)
    res.once('error', onError)
    res.once('close', onClose)
  })
}

function makeClientAbortedError(usage = null) {
  const error = new Error('Client disconnected before the upstream response completed.')
  error.code = CLIENT_ABORTED_CODE
  error.usage = usage
  return error
}

function listModels(config) {
  const routeModels = config.routes.filter((route) => route.enabled).map((route) => route.virtualModel)
  const providerModels = config.providers.flatMap((provider) => provider.models)
  return [...new Set([...routeModels, ...providerModels])].filter(Boolean).sort()
}

function shouldRetryStatus(status, retryStatusCodes) {
  return retryStatusCodes.includes(status)
}

function isAuthorized(headers, expectedKey) {
  if (!expectedKey) return true
  const xApiKey = String(headers['x-api-key'] || '').trim()
  if (xApiKey === expectedKey) return true

  const authorization = String(headers.authorization || '').trim()
  if (authorization === expectedKey) return true
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() === expectedKey
  }
  return false
}

function publicAttempt(attempt) {
  return {
    providerName: attempt.providerName,
    credentialLabel: attempt.credentialLabel || '',
    model: attempt.model,
    status: attempt.status ?? null,
    latencyMs: attempt.latencyMs ?? null,
    error: attempt.error ? preview(attempt.error) : null,
  }
}

function preview(value, maxLength = 500) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function sendJson(res, status, body) {
  res.statusCode = status
  clearResponseHeaders(res)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body, null, 2))
}

function clearResponseHeaders(res) {
  if (res.headersSent) return
  for (const name of res.getHeaderNames()) {
    res.removeHeader(name)
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    req.on('data', (chunk) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        const error = new Error('Request body is too large.')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}
