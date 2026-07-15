import {
  credentialSecret,
  isCredentialUsable,
  resolveActiveCredential,
  resolveActiveKey,
} from './config-store.mjs'
import { getCachedSystemProxy, resolveProviderOutboundProxy } from './outbound-proxy.mjs'
import { upstreamErrorMessage } from './response-validation.mjs'
import { buildReasoningFallback } from './reasoning-fallback.mjs'
import { describeRoutingSkip, describeUpstreamFailure, redactSecretText } from './upstream-diagnostics.mjs'
import {
  buildWireBody,
  buildWirePlan,
  buildWireUrl,
  createWireStreamTransformer,
  normalizeUsagePayload,
  transformWireResponse,
} from './wire-api.mjs'
import { upstreamFetch } from './upstream-fetch.mjs'
import { isCodexOAuthCredential } from './oauth/codex-oauth.mjs'
import { normalizeCodexOAuthRequest, resolveCodexOAuthSessionId } from './oauth/codex-request.mjs'
import { CredentialRefreshError, prepareCredential } from './oauth/token-refresh.mjs'

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
const LOCAL_RELAY_HEADERS = new Set([
  'x-local-relay-session',
  'x-local-model-relay-session',
])

const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024
const MAX_USAGE_SNIFF_BYTES = 10 * 1024 * 1024
const MAX_STREAM_INSPECT_CHARS = 1024 * 1024
const MAX_STREAM_PRELUDE_BYTES = 256 * 1024
const MAX_RESPONSE_ID_SNIFF_BYTES = 512 * 1024
const CLIENT_ABORTED_CODE = 'CLIENT_ABORTED'
const UPSTREAM_STREAM_FAILED_CODE = 'UPSTREAM_STREAM_FAILED'
const UPSTREAM_STREAM_INCOMPLETE_CODE = 'UPSTREAM_STREAM_INCOMPLETE'
const UPSTREAM_STREAM_IDLE_CODE = 'UPSTREAM_STREAM_IDLE_TIMEOUT'
const UPSTREAM_PAYLOAD_FAILED_CODE = 'UPSTREAM_PAYLOAD_FAILED'
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
    const models = listModels(config)
    return sendJson(res, 200, {
      object: 'list',
      data: models.map((model) => ({
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'local-model-relay',
      })),
      // Codex currently expects its private model catalog envelope. An empty
      // remote catalog keeps Codex's bundled metadata while preserving the
      // standard OpenAI-compatible `data` list for other clients.
      models: [],
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
  const sessionContext = resolveSessionContext(req, body, stateStore, config.service)
  const candidateContext = buildCandidateContext(
    config,
    route,
    virtualModel,
    stateStore,
    sessionContext.preferredProviderId,
  )
  const candidates = candidateContext.candidates
  const routingDiagnostics = [
    ...candidateContext.diagnostics,
    ...sessionAffinityDiagnostics(sessionContext, candidates, config, virtualModel, candidateContext.pinned),
  ]
  const attempts = []
  let lastError = null

  if (candidates.length === 0) {
    const pinned = candidateContext.pinned
    const errorType = pinned ? 'pinned_start_unavailable' : 'no_available_provider'
    const message = pinned
      ? `Pinned start provider "${pinned.providerName || 'unknown'}" cannot route model "${virtualModel || '(missing)'}".`
      : `No available provider route for model "${virtualModel || '(missing)'}".`
    addRequestLog(config, stateStore, {
      method: req.method,
      path: req.url,
      model: virtualModel,
      status: 503,
      ok: false,
      attempts: [],
      durationMs: Date.now() - startedAt,
      error: message,
      outcome: errorType,
      diagnostics: routingDiagnostics,
    })
    return sendJson(res, 503, {
      error: {
        type: errorType,
        message,
      },
      diagnostics: routingDiagnostics,
    })
  }

  for (const candidate of candidates.slice(0, config.service.maxAttempts)) {
    let credential = candidate.credential || null
    const attempt = {
        providerId: candidate.provider.id,
        providerName: candidate.provider.name,
        credentialId: credential?.id || '',
        credentialLabel: credential?.label || '',
        credentialKind: credential?.kind || '',
        model: candidate.model,
        startedAt: Date.now(),
    }
    attempts.push(attempt)
    stateStore.markAttempt(candidate.provider.id)

    try {
      if (credential) {
        credential = await prepareCredential(configStore, candidate.provider, credential, config.service)
        candidate.credential = credential
      }
      let requestBody = body
      let upstream = await callUpstream(req, requestBody, candidate, config.service)
      let upstreamResponse = upstream.response
      let latencyMs = Date.now() - attempt.startedAt
      attempt.status = upstreamResponse.status
      attempt.latencyMs = latencyMs
      let capturedUsage = null
      let streamInfo = null
      let responseId = ''

      let authRefresh = null
      if ([401, 403].includes(upstreamResponse.status) && isOAuthCredential(credential) && credential.refreshToken) {
        try {
          const refreshed = await prepareCredential(configStore, candidate.provider, credential, config.service, { force: true })
          upstream.abort()
          credential = refreshed
          candidate.credential = refreshed
          authRefresh = { attempted: true, ok: true }
          attempt.authRefresh = authRefresh
          upstream = await callUpstream(req, requestBody, candidate, config.service)
          upstreamResponse = upstream.response
          latencyMs = Date.now() - attempt.startedAt
          attempt.status = upstreamResponse.status
          attempt.latencyMs = latencyMs
        } catch (error) {
          authRefresh = {
            attempted: true,
            ok: false,
            code: error?.code || 'oauth_refresh_failed',
            permanent: error?.permanent === true,
          }
          attempt.authRefresh = authRefresh
        }
      }

      if (shouldRequireOAuthReauth(upstreamResponse.status, credential, authRefresh)) {
        configStore.updateCredentialAuth(candidate.provider.id, credential.id, {
          authStatus: 'reauth_required',
          lastAuthError: 'HTTP 401',
        })
      }

      if (upstreamResponse.status >= 400) {
        const firstFailureMessage = redactSecretText(
          await readPreview(upstreamResponse.clone(), null, candidate.provider.timeoutMs),
          credentialSecret(credential),
        )
        const fallback = buildReasoningFallback(body, {
          status: upstreamResponse.status,
          message: firstFailureMessage,
        })
        if (fallback) {
          attempt.reasoningFallback = {
            from: fallback.from,
            to: fallback.to,
            triggerStatus: upstreamResponse.status,
            reason: fallback.reason,
          }
          upstream.abort()
          requestBody = fallback.body
          upstream = await callUpstream(req, requestBody, candidate, config.service)
          upstreamResponse = upstream.response
          latencyMs = Date.now() - attempt.startedAt
          attempt.status = upstreamResponse.status
          attempt.latencyMs = latencyMs
        }
      }

      if (shouldRetryStatus(upstreamResponse.status, config.service.retryStatusCodes)) {
        const message = redactSecretText(
          await readPreview(upstreamResponse, upstream.abort, candidate.provider.timeoutMs),
          credentialSecret(credential),
        )
        const diagnostic = describeUpstreamFailure(upstreamResponse.status, message)
        attempt.error = message
        attempt.outcome = 'upstream_error'
        attempt.diagnostic = diagnostic
        stateStore.markFailure(candidate.provider.id, {
          status: upstreamResponse.status,
          message,
          latencyMs,
          cooldownSeconds: candidate.provider.cooldownSeconds,
        })
        lastError = { status: upstreamResponse.status, message, diagnostic }
        continue
      }

      const ok = upstreamResponse.status < 400
      try {
        const piped = await pipeUpstreamResponse(upstreamResponse, res, candidate, attempts.length, upstream.abort, {
          collectUsage: config.service.collectUsage,
          requestBody,
          wirePlan: upstream.wirePlan,
        })
        capturedUsage = piped.usage
        streamInfo = piped.stream
        responseId = piped.responseId || ''
      } catch (streamError) {
        upstream.abort()
        const message = redactSecretText(
          streamError instanceof Error ? streamError.message : String(streamError),
          credentialSecret(credential),
        )
        capturedUsage = capturedUsage || streamError?.usage || null
        streamInfo = streamInfo || streamError?.stream || null
        if (streamError?.code === UPSTREAM_STREAM_FAILED_CODE) attempt.outcome = 'upstream_stream_failed'
        if (streamError?.code === UPSTREAM_STREAM_INCOMPLETE_CODE) attempt.outcome = 'upstream_stream_incomplete'
        if (streamError?.code === UPSTREAM_STREAM_IDLE_CODE) attempt.outcome = 'upstream_stream_idle_timeout'
        if (streamError?.code === UPSTREAM_PAYLOAD_FAILED_CODE) attempt.outcome = 'upstream_payload_failed'
        const outcome = streamError?.code === CLIENT_ABORTED_CODE
          ? classifyClientAbort(streamInfo)
          : streamError?.code === UPSTREAM_PAYLOAD_FAILED_CODE
            ? 'upstream_payload_failed'
            : streamError?.code === UPSTREAM_STREAM_FAILED_CODE
              ? 'upstream_stream_failed'
              : streamError?.code === UPSTREAM_STREAM_INCOMPLETE_CODE
                ? 'upstream_stream_incomplete'
                : streamError?.code === UPSTREAM_STREAM_IDLE_CODE
                  ? 'upstream_stream_idle_timeout'
                  : ''
        const semanticallyComplete = streamError?.code === CLIENT_ABORTED_CODE &&
          ok &&
          outcome !== 'client_disconnected'
        attempt.error = semanticallyComplete ? '' : message
        attempt.outcome = outcome
        if (!semanticallyComplete && outcome !== 'client_disconnected') {
          attempt.diagnostic = describeUpstreamFailure(
            upstreamResponse.status,
            message,
            outcome,
          )
        }

        if (streamError?.code === CLIENT_ABORTED_CODE) {
          if (semanticallyComplete) {
            stateStore.markSuccess(candidate.provider.id, {
              status: upstreamResponse.status,
              latencyMs,
            })
            stateStore.advanceStartProvider?.(candidate.provider.id)
          } else {
            const reconnect = stateStore.markReconnectFailure?.(candidate.provider.id, {
              status: upstreamResponse.status,
              message,
              latencyMs: Date.now() - attempt.startedAt,
              threshold: config.service.reconnectFailureThreshold,
              cooldownSeconds: config.service.reconnectCooldownSeconds,
              windowSeconds: 300,
            })
            attempt.reconnectFailureCount = reconnect?.count || 0
            attempt.reconnectFailureThreshold = reconnect?.threshold || config.service.reconnectFailureThreshold
            attempt.failoverArmed = Boolean(reconnect?.tripped)
          }
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
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            status: upstreamResponse.status,
            ok: semanticallyComplete,
            attempts: attempts.map(publicAttempt),
            durationMs: Date.now() - startedAt,
            error: semanticallyComplete ? undefined : message,
            outcome,
            stream: streamInfo,
            usage: capturedUsage,
            diagnostics: requestDiagnostics(routingDiagnostics, attempts),
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
          providerId: candidate.provider.id,
          providerName: candidate.provider.name,
          status: upstreamResponse.status || 0,
          ok: false,
          attempts: attempts.map(publicAttempt),
          durationMs: Date.now() - startedAt,
          error: message,
          usage: capturedUsage,
          outcome,
          diagnostics: requestDiagnostics(routingDiagnostics, attempts),
        })

        if (res.headersSent || res.writableEnded || res.destroyed) {
          if (!res.destroyed) res.destroy(streamError)
          return
        }

        clearResponseHeaders(res)
        lastError = {
          status: upstreamResponse.status >= 400 ? upstreamResponse.status : 502,
          message,
          diagnostic: attempt.diagnostic,
        }
        continue
      }

      if (ok) {
        stateStore.markSuccess(candidate.provider.id, {
          status: upstreamResponse.status,
          latencyMs,
        })
        stateStore.advanceStartProvider?.(candidate.provider.id)
        if (isOAuthCredential(credential) && candidate.provider.activeCredentialId !== credential.id) {
          configStore.setActiveCredential(candidate.provider.id, credential.id)
        }
        persistSessionAffinity(
          stateStore,
          sessionContext,
          req.url,
          responseId,
          candidate,
          virtualModel,
          config.service,
        )
        if (capturedUsage) {
          stateStore.recordUsage(candidate.provider.id, candidate.model, capturedUsage, {
            credentialId: attempt.credentialId,
            latencyMs,
          })
        }
      } else {
        const message = `HTTP ${upstreamResponse.status}`
        attempt.error = message
        attempt.outcome = 'upstream_error'
        attempt.diagnostic = describeUpstreamFailure(upstreamResponse.status, message)
        stateStore.markFailure(candidate.provider.id, {
          status: upstreamResponse.status,
          message,
          latencyMs,
          cooldownSeconds: 0,
        })
      }
      addRequestLog(config, stateStore, {
        method: req.method,
        path: req.url,
        model: virtualModel,
        routedModel: candidate.model,
        providerId: candidate.provider.id,
        providerName: candidate.provider.name,
        status: upstreamResponse.status,
        ok,
        attempts: attempts.map(publicAttempt),
        durationMs: Date.now() - startedAt,
        outcome: ok ? 'completed' : 'upstream_error',
        stream: streamInfo,
        usage: ok ? capturedUsage : null,
        diagnostics: requestDiagnostics(routingDiagnostics, attempts),
      })
      return
    } catch (error) {
      const latencyMs = Date.now() - attempt.startedAt
      const message = redactSecretText(
        error instanceof Error ? error.message : String(error),
        credentialSecret(credential),
      )
      const authFailure = error instanceof CredentialRefreshError
      attempt.status = authFailure ? 401 : 0
      attempt.latencyMs = latencyMs
      attempt.error = message
      attempt.outcome = authFailure ? 'oauth_refresh_failed' : 'upstream_error'
      attempt.diagnostic = describeUpstreamFailure(authFailure ? 401 : 0, message, '', {
        timedOut: error?.name === 'AbortError',
      })
      stateStore.markFailure(candidate.provider.id, {
        status: authFailure ? 401 : 0,
        message,
        latencyMs,
        cooldownSeconds: candidate.provider.cooldownSeconds,
      })
      lastError = { status: authFailure ? 401 : 0, message, diagnostic: attempt.diagnostic }
    }
  }

  const pinned = candidateContext.pinned
  const failureType = pinned ? 'pinned_provider_failed' : 'all_providers_failed'
  const failureMessage = pinned
    ? lastError?.message || `Pinned start provider "${pinned.providerName || 'unknown'}" failed.`
    : lastError?.message || 'Every provider failed.'

  addRequestLog(config, stateStore, {
    method: req.method,
    path: req.url,
    model: virtualModel,
    status: lastError?.status || 502,
    ok: false,
    attempts: attempts.map(publicAttempt),
    durationMs: Date.now() - startedAt,
    error: failureMessage,
    outcome: failureType,
    diagnostics: requestDiagnostics(routingDiagnostics, attempts),
  })

  return sendJson(res, lastError?.status && lastError.status >= 400 ? lastError.status : 502, {
    error: {
      type: failureType,
      message: failureMessage,
    },
    attempts: attempts.map(publicAttempt),
    diagnostics: requestDiagnostics(routingDiagnostics, attempts),
  })
}

function addRequestLog(config, stateStore, entry) {
  if (config.service.logRequests) stateStore.addRequestLog(entry, config.service.requestLogLimit)
}

export function findRoute(config, virtualModel) {
  if (!virtualModel) return null
  return config.routes.find((route) => route.enabled && route.virtualModel === virtualModel) || null
}

export function buildCandidates(config, route, virtualModel, stateStore, preferredProviderId = '') {
  return buildCandidateContext(config, route, virtualModel, stateStore, preferredProviderId).candidates
}

function buildCandidateContext(config, route, virtualModel, stateStore, preferredProviderId = '') {
  const providers = [...config.providers].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  const routing = currentRouting(stateStore)
  const now = Date.now()
  const candidates = []
  const diagnostics = []

  if (route) {
    for (const target of [...route.targets].sort((a, b) => a.priority - b.priority)) {
      const provider = providersById.get(target.providerId)
      if (!provider) continue

      const reason = providerSkipReason(provider, stateStore, now, null)
      if (reason) {
        diagnostics.push(describeRoutingSkip(provider, reason, target.model))
        continue
      }
      candidates.push(...providerCredentialCandidates(provider, target.model))
    }
    return finalizeCandidateContext(candidates, diagnostics, providersById, route, virtualModel, routing, preferredProviderId)
  }

  for (const provider of providers) {
    const reason = providerSkipReason(provider, stateStore, now, virtualModel)
    if (reason) {
      diagnostics.push(describeRoutingSkip(provider, reason, virtualModel))
      continue
    }
    candidates.push(...providerCredentialCandidates(provider, virtualModel))
  }

  return finalizeCandidateContext(candidates, diagnostics, providersById, route, virtualModel, routing, preferredProviderId)
}

function finalizeCandidateContext(candidates, diagnostics, providersById, route, virtualModel, routing, preferredProviderId) {
  const pinnedProviderId = routing.startMode === 'pinned' ? routing.startProviderId : ''
  if (pinnedProviderId) {
    const provider = providersById.get(pinnedProviderId)
    const pinned = {
      providerId: pinnedProviderId,
      providerName: provider?.name || '',
    }
    const pinnedCandidates = candidates.filter((item) => item.provider.id === pinnedProviderId)
    if (pinnedCandidates.length) return { candidates: pinnedCandidates, diagnostics, pinned, routing }

    diagnostics.push(describePinnedStartUnavailable(provider, route, virtualModel))
    return { candidates: [], diagnostics, pinned, routing }
  }

  return {
    candidates: rotateToStart(candidates, preferredProviderId || routing.startProviderId),
    diagnostics,
    pinned: null,
    routing,
  }
}

function currentRouting(stateStore) {
  const routing = stateStore.getRouting?.() || {}
  const startProviderId = typeof routing.startProviderId === 'string'
    ? routing.startProviderId
    : stateStore.getStartProviderId?.() || ''
  const startMode = routing.startMode === 'pinned'
    ? 'pinned'
    : routing.startMode === 'locked'
      ? 'locked'
      : 'auto'
  return { startProviderId, startMode }
}

function describePinnedStartUnavailable(provider, route, model) {
  const providerName = provider?.name || '当前起点'
  const isRouteTarget = Boolean(route?.targets?.some((target) => target.providerId === provider?.id))
  return {
    type: 'routing_lock',
    code: 'pinned_start_unavailable',
    status: 0,
    providerId: provider?.id || '',
    providerName,
    model,
    title: '单线锁定无法转发',
    message: route && !isRouteTarget
      ? `当前起点线路「${providerName}」不是模型「${model || '(未指定)'}」的路由目标。`
      : `当前起点线路「${providerName}」目前无法处理模型「${model || '(未指定)'}」。`,
    suggestion: '检查起点线路的开关、Key、冷却状态、支持模型和模型路由；修复后重试，或切换为允许故障转移的模式。',
  }
}

function providerSkipReason(provider, stateStore, now, virtualModel = null) {
  if (!provider.enabled) return 'provider_disabled'
  if (provider.authMode !== 'none' && !resolveActiveKey(provider)) return 'no_enabled_key'
  if (stateStore.isCooling(provider.id, now)) return 'cooldown'
  if (virtualModel !== null && provider.models.length > 0 && !provider.models.includes(virtualModel)) return 'unsupported_model'
  return ''
}

function providerCredentialCandidates(provider, model) {
  if (provider.authMode === 'none') return [{ provider, credential: null, model }]
  const active = resolveActiveCredential(provider)
  if (!active) return []
  if (!isOAuthCredential(active)) return [{ provider, credential: active, model }]

  const oauthCredentials = (provider.credentials || []).filter((credential) => (
    isCredentialUsable(credential) && isOAuthCredential(credential)
  ))
  const index = oauthCredentials.findIndex((credential) => credential.id === active.id)
  const ordered = index > 0
    ? [...oauthCredentials.slice(index), ...oauthCredentials.slice(0, index)]
    : oauthCredentials
  return ordered.map((credential) => ({ provider, credential, model }))
}

export function shouldRequireOAuthReauth(status, credential, authRefresh = null) {
  if (status !== 401 || !isOAuthCredential(credential)) return false
  if (!credential.refreshToken) return true
  return authRefresh?.ok === true || authRefresh?.permanent === true
}

function isOAuthCredential(credential) {
  return isCodexOAuthCredential(credential)
}

function resolveSessionContext(req, body, stateStore, serviceConfig) {
  if (serviceConfig.sessionAffinity === false) {
    return { keys: [], preferredProviderId: '', binding: null }
  }

  const keys = []
  const headerValue = sessionValue(
    req.headers['x-local-relay-session'] || req.headers['x-local-model-relay-session'],
  )
  if (headerValue) keys.push({ kind: 'client', value: headerValue, source: 'header' })

  const metadata = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : null
  const metadataValue = sessionValue(metadata?.local_relay_session_id || metadata?.local_model_relay_session_id)
  if (metadataValue) keys.push({ kind: 'client', value: metadataValue, source: 'metadata' })

  const previousResponseId = sessionValue(body?.previous_response_id)
  if (previousResponseId) keys.push({ kind: 'response', value: previousResponseId, source: 'previous_response_id' })

  for (const key of keys) {
    const binding = stateStore.getSessionBinding?.(key.kind, key.value)
    if (binding?.providerId) {
      return {
        keys,
        preferredProviderId: binding.providerId,
        binding: { ...binding, source: key.source },
      }
    }
  }

  return { keys, preferredProviderId: '', binding: null }
}

function sessionAffinityDiagnostics(sessionContext, candidates, config, virtualModel, pinned = null) {
  if (!sessionContext.binding?.providerId) return []
  if (pinned?.providerId && sessionContext.binding.providerId !== pinned.providerId) {
    const provider = config.providers.find((item) => item.id === pinned.providerId)
    return [{
      type: 'session_affinity',
      code: 'session_affinity_overridden_by_pinned_start',
      title: '会话线路亲和已被单线锁定覆盖',
      message: `单线锁定要求本次请求固定使用起点线路「${provider?.name || pinned.providerName || '已删除线路'}」。`,
      suggestion: '如需恢复会话原线路或允许备用线路，请切换为“锁定起点”或“自动推进”。',
      providerId: pinned.providerId,
      providerName: provider?.name || pinned.providerName || '',
      model: virtualModel,
      source: sessionContext.binding.source,
    }]
  }
  if (candidates.some((candidate) => candidate.provider.id === sessionContext.binding.providerId)) return []
  const provider = config.providers.find((item) => item.id === sessionContext.binding.providerId)
  return [{
    type: 'session_affinity',
    code: 'session_affinity_bypassed',
    title: '会话线路亲和已绕过',
    message: `已绑定的线路「${provider?.name || '已删除线路'}」当前无法处理模型「${virtualModel || '(未指定)'}」。`,
    suggestion: '已按普通路由继续尝试；请检查绑定线路的开关、Key、冷却状态和模型支持列表。',
    providerId: sessionContext.binding.providerId,
    providerName: provider?.name || '',
    model: virtualModel,
    source: sessionContext.binding.source,
  }]
}

function persistSessionAffinity(stateStore, sessionContext, requestUrl, responseId, candidate, virtualModel, serviceConfig) {
  if (serviceConfig.sessionAffinity === false) return
  const keys = [...sessionContext.keys]
  if (isResponsesRequest(requestUrl) && responseId) {
    keys.push({ kind: 'response', value: responseId, source: 'response_id' })
  }
  const seen = new Set()
  for (const key of keys) {
    const fingerprint = `${key.kind}:${key.value}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    stateStore.setSessionBinding?.(key.kind, key.value, {
      providerId: candidate.provider.id,
      model: virtualModel,
      protocol: isResponsesRequest(requestUrl) ? 'responses' : 'chat',
      source: key.source,
    }, {
      ttlSeconds: serviceConfig.sessionTtlSeconds,
      limit: serviceConfig.sessionLimit,
    })
  }
}

function isResponsesRequest(requestUrl) {
  const path = new URL(requestUrl, 'http://local').pathname.replace(/\/+$/, '')
  return path === '/v1/responses' || path === '/responses'
}

function sessionValue(value) {
  const text = Array.isArray(value) ? value[0] : value
  if (typeof text !== 'string') return ''
  return text.trim().slice(0, 1024)
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
  const builtBody = buildWireBody(body, candidate, serviceConfig, wirePlan)
  const codexSessionId = candidate.provider.providerType === 'codex_oauth'
    ? resolveCodexOAuthSessionId(req.headers, body)
    : ''
  const upstreamBody = candidate.provider.providerType === 'codex_oauth'
    ? normalizeCodexOAuthRequest(builtBody, { sessionId: codexSessionId })
    : builtBody

  try {
    const response = await upstreamFetch(upstreamUrl, {
      method: req.method,
      headers: buildHeaders(req.headers, candidate.provider, candidate.credential, { codexSessionId }),
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

function buildHeaders(source, provider, credential = resolveActiveCredential(provider), options = {}) {
  const headers = new Headers()
  const apiKey = credentialSecret(credential)

  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || LOCAL_RELAY_HEADERS.has(lower) || lower === 'authorization' || lower === 'x-api-key') continue
    if (Array.isArray(value)) {
      headers.set(name, value.join(', '))
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }

  headers.set('content-type', 'application/json')

  if (apiKey && (provider.authMode === 'authorization' || provider.authMode === 'both')) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }

  if (apiKey && (provider.authMode === 'x-api-key' || provider.authMode === 'both')) {
    headers.set('x-api-key', apiKey)
  }

  if (provider.providerType === 'codex_oauth' && isCodexOAuthCredential(credential)) {
    headers.set('authorization', `Bearer ${credential.accessToken}`)
    headers.delete('x-api-key')
    headers.set('originator', 'codex_cli_rs')
    headers.set('user-agent', 'codex_cli_rs/0.144.2')
    headers.set('version', '0.144.2')
    headers.set('session_id', options.codexSessionId || headers.get('session_id') || credential.id || 'local-model-relay')
    if (credential.accountId) headers.set('chatgpt-account-id', credential.accountId)
  }

  return headers
}

async function readPreview(response, abortUpstream, timeoutMs = 30000) {
  const contentType = response.headers.get('content-type') || ''
  let text = ''
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abortUpstream?.()
  }, timeoutMs)

  try {
    text = await response.text()
  } catch {
    if (timedOut) return `HTTP ${response.status} response body timed out after ${timeoutMs} ms.`
    return `HTTP ${response.status}`
  } finally {
    clearTimeout(timeout)
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
  const contentType = upstreamResponse.headers.get('content-type') || ''
  if (isJsonContentType(contentType)) {
    const errorMessage = await inspectJsonUpstreamError(upstreamResponse)
    if (errorMessage) throw makeUpstreamPayloadError(errorMessage, upstreamResponse.status)
  }

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

  const transformsStream = Boolean(options.wirePlan?.transform) && contentType.includes('text/event-stream')
  if (options.wirePlan?.transform && !transformsStream) {
    const transformed = await transformWireResponse(upstreamResponse, res, options.wirePlan)
    return { usage: transformed.usage, stream: null, responseId: transformed.responseId }
  }

  if (!upstreamResponse.body) {
    res.end()
    return { usage: null, stream: null }
  }

  const usageCollector = createUsageCollector(upstreamResponse, options.collectUsage, options.requestBody)
  const streamInspector = createStreamInspector(upstreamResponse)
  const responseIdCollector = createResponseIdCollector(upstreamResponse)
  const wireTransformer = transformsStream ? createWireStreamTransformer(options.wirePlan) : null
  const clientAbort = new AbortController()
  let clientDisconnected = false
  let idleTimedOut = false
  let idleTimeout = null
  let streamCommitted = !streamInspector.snapshot().isStream
  let preludeBytes = 0
  const preludeChunks = []

  const flushPrelude = async () => {
    if (streamCommitted && preludeChunks.length === 0) return
    streamCommitted = true
    for (const chunk of preludeChunks.splice(0)) {
      await writeResponseChunk(res, chunk)
    }
  }

  const writeOrBuffer = async (chunk) => {
    if (streamCommitted) return writeResponseChunk(res, chunk)
    const buffered = Buffer.from(chunk)
    preludeChunks.push(buffered)
    preludeBytes += buffered.length
  }

  const armIdleTimeout = () => {
    clearTimeout(idleTimeout)
    idleTimeout = setTimeout(() => {
      idleTimedOut = true
      abortUpstream?.()
    }, candidate.provider.timeoutMs)
  }
  const onClientClose = () => {
    if (res.writableEnded) return
    clientDisconnected = true
    abortUpstream?.()
    clientAbort.abort(makeClientAbortedError(
      usageCollector.usage || usageCollector.estimate(),
      streamInspector.snapshot(),
    ))
  }

  res.once('close', onClientClose)
  armIdleTimeout()

  try {
    await upstreamResponse.body.pipeTo(new WritableStream({
      async write(chunk) {
        armIdleTimeout()
        usageCollector.ingest(chunk)
        streamInspector.ingest(chunk)
        responseIdCollector.ingest(chunk)
        const snapshot = streamInspector.snapshot()

        if (snapshot.failureReason) {
          throw makeUpstreamStreamError(snapshot.failureReason, snapshot)
        }
        const outputs = wireTransformer ? wireTransformer.ingest(chunk) : [chunk]
        for (const output of outputs) await writeOrBuffer(output)
        if (snapshot.sawMeaningfulOutput || streamCompletionReason(snapshot) || preludeBytes >= MAX_STREAM_PRELUDE_BYTES) {
          await flushPrelude()
        }
      },
      async close() {
        clearTimeout(idleTimeout)
        usageCollector.finish()
        streamInspector.finish()
        responseIdCollector.finish()
        const snapshot = streamInspector.snapshot()
        if (snapshot.failureReason) {
          throw makeUpstreamStreamError(snapshot.failureReason, snapshot)
        }
        if (snapshot.isStream && !streamCompletionReason(snapshot)) {
          throw makeUpstreamStreamIncompleteError(snapshot)
        }
        if (wireTransformer) {
          for (const output of wireTransformer.finish()) await writeOrBuffer(output)
        }
        await flushPrelude()
        if (!res.writableEnded) res.end()
      },
      abort(error) {
        if (res.headersSent && !res.destroyed) res.destroy(error)
      },
    }), { signal: clientAbort.signal })
  } catch (error) {
    streamInspector.finish()
    const snapshot = streamInspector.snapshot()
    if (clientDisconnected || error?.code === CLIENT_ABORTED_CODE) {
      throw makeClientAbortedError(
        usageCollector.usage || usageCollector.estimate(),
        snapshot,
      )
    }
    if (idleTimedOut) {
      throw makeUpstreamStreamIdleError(candidate.provider.timeoutMs, snapshot, usageCollector.usage || usageCollector.estimate())
    }
    if (error && typeof error === 'object') {
      error.usage ??= usageCollector.usage || usageCollector.estimate()
      error.stream ??= snapshot
    }
    throw error
  } finally {
    clearTimeout(idleTimeout)
    res.off('close', onClientClose)
  }

  return {
    usage: usageCollector.usage || wireTransformer?.usage() || null,
    stream: streamInspector.snapshot(),
    responseId: wireTransformer?.responseId() || streamInspector.snapshot().responseId || responseIdCollector.responseId() || '',
  }
}

function createStreamInspector(response) {
  const contentType = response.headers.get('content-type') || ''
  const isStream = contentType.includes('text/event-stream')
  let buffer = ''
  let disabled = false
  const state = {
    contentType,
    isStream,
    bytes: 0,
    chunks: 0,
    eventCount: 0,
    lastEventType: '',
    sawResponseCompleted: false,
    sawDoneSentinel: false,
    sawToolCallDone: false,
    sawOutputDone: false,
    sawChatFinish: false,
    sawMeaningfulOutput: false,
    failureReason: '',
    responseId: '',
  }

  const processText = (text) => {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data) continue
      if (data === '[DONE]') {
        state.sawDoneSentinel = true
        state.lastEventType = '[DONE]'
        continue
      }
      if (!data.startsWith('{')) continue

      try {
        const payload = JSON.parse(data)
        const type = typeof payload?.type === 'string' ? payload.type : ''
        const responseId = responseIdFromStreamPayload(payload, type)
        if (responseId) state.responseId = responseId
        if (type) {
          state.eventCount += 1
          state.lastEventType = type
        }
        if (type === 'response.completed' || payload?.response?.status === 'completed') {
          state.sawResponseCompleted = true
        }
        if (type === 'response.failed' || type === 'error' || payload?.response?.status === 'failed' || payload?.error) {
          state.failureReason = streamFailureMessage(payload, type)
        }
        if (isMeaningfulStreamPayload(payload, type)) {
          state.sawMeaningfulOutput = true
        }
        if (
          type === 'response.function_call_arguments.done' ||
          (type === 'response.output_item.done' && payload?.item?.type === 'function_call')
        ) {
          state.sawToolCallDone = true
        }
        if (type === 'response.output_text.done' || type === 'response.refusal.done') {
          state.sawOutputDone = true
        }
        if (Array.isArray(payload?.choices) && payload.choices.some((choice) => choice?.finish_reason)) {
          state.sawChatFinish = true
          if (payload.choices.some((choice) => choice?.finish_reason === 'tool_calls')) {
            state.sawToolCallDone = true
          }
        }
      } catch {}
    }
  }

  return {
    ingest(chunk) {
      const bytes = chunk.byteLength ?? chunk.length ?? 0
      state.bytes += bytes
      state.chunks += 1
      if (!isStream || disabled) return

      buffer += Buffer.from(chunk).toString('utf8')
      if (buffer.length > MAX_STREAM_INSPECT_CHARS) {
        disabled = true
        buffer = ''
        return
      }

      const lastNewline = buffer.lastIndexOf('\n')
      if (lastNewline < 0) return
      processText(buffer.slice(0, lastNewline + 1))
      buffer = buffer.slice(lastNewline + 1)
    },
    finish() {
      if (!disabled && buffer) processText(buffer)
      buffer = ''
    },
    snapshot() {
      return {
        ...state,
        completionReason: streamCompletionReason(state),
      }
    },
  }
}

function createResponseIdCollector(response) {
  const contentType = response.headers.get('content-type') || ''
  if (!isJsonContentType(contentType)) {
    return {
      ingest() {},
      finish() {},
      responseId() { return '' },
    }
  }

  const chunks = []
  let totalBytes = 0
  let disabled = false
  let id = ''

  return {
    ingest(chunk) {
      if (disabled || id) return
      const bytes = Buffer.from(chunk)
      totalBytes += bytes.length
      if (totalBytes > MAX_RESPONSE_ID_SNIFF_BYTES) {
        disabled = true
        chunks.length = 0
        return
      }
      chunks.push(bytes)
    },
    finish() {
      if (disabled || id || chunks.length === 0) return
      try {
        const payload = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'))
        id = responseIdFromJsonPayload(payload)
      } catch {}
      chunks.length = 0
    },
    responseId() {
      return id
    },
  }
}

function responseIdFromJsonPayload(payload) {
  if (typeof payload?.id === 'string' && payload.id) return payload.id
  if (typeof payload?.response?.id === 'string' && payload.response.id) return payload.response.id
  return ''
}

function responseIdFromStreamPayload(payload, type) {
  if (typeof payload?.response_id === 'string' && payload.response_id) return payload.response_id
  if (typeof payload?.response?.id === 'string' && payload.response.id) return payload.response.id
  if (type.startsWith('response.') && typeof payload?.id === 'string' && payload.id) return payload.id
  return ''
}

function streamCompletionReason(stream) {
  if (stream?.sawResponseCompleted || stream?.sawDoneSentinel || stream?.sawOutputDone) {
    return 'response_complete'
  }
  if (stream?.sawToolCallDone) return 'tool_call_handoff'
  if (stream?.sawChatFinish) return 'response_complete'
  return ''
}

function classifyClientAbort(stream) {
  return streamCompletionReason(stream) || 'client_disconnected'
}

function isMeaningfulStreamPayload(payload, type) {
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta' || type === 'response.function_call_arguments.delta') {
    return Boolean(payload?.delta)
  }
  if (type.includes('reasoning') && type.endsWith('.delta')) {
    return Boolean(payload?.delta || payload?.text)
  }
  if (!Array.isArray(payload?.choices)) return false
  return payload.choices.some((choice) => {
    const delta = choice?.delta
    return Boolean(delta?.content || delta?.refusal || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length))
  })
}

function streamFailureMessage(payload, type) {
  const message = payload?.error?.message || payload?.response?.error?.message || payload?.message
  return preview(String(message || type || 'Upstream stream reported a failure.'))
}

function isJsonContentType(contentType) {
  return contentType.includes('application/json') || contentType.includes('+json')
}

async function inspectJsonUpstreamError(response) {
  if (typeof response.clone !== 'function') return ''
  try {
    const text = await response.clone().text()
    if (!text.trim()) return ''
    return upstreamErrorMessage(JSON.parse(text))
  } catch {
    return ''
  }
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
      cachedTokensReported: false,
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
  return normalizeUsagePayload(payload?.usage || payload?.response?.usage)
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
  if (typeof payload?.delta === 'string') chars += payload.delta.length
  if (Array.isArray(payload?.choices)) {
    for (const choice of payload.choices) {
      chars += contentLength(choice?.message?.content)
      chars += contentLength(choice?.delta?.content)
      chars += contentLength(choice?.text)
      if (Array.isArray(choice?.delta?.tool_calls)) {
        for (const toolCall of choice.delta.tool_calls) {
          chars += contentLength(toolCall?.function?.arguments)
        }
      }
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

function makeClientAbortedError(usage = null, stream = null) {
  const error = new Error('Client disconnected before the upstream response completed.')
  error.code = CLIENT_ABORTED_CODE
  error.usage = usage
  error.stream = stream
  return error
}

function makeUpstreamStreamError(message, stream = null) {
  const error = new Error(`Upstream stream failed before completion: ${message}`)
  error.code = UPSTREAM_STREAM_FAILED_CODE
  error.stream = stream
  return error
}

function makeUpstreamStreamIncompleteError(stream = null) {
  const error = new Error('Upstream stream ended before a completion event was received.')
  error.code = UPSTREAM_STREAM_INCOMPLETE_CODE
  error.stream = stream
  return error
}

function makeUpstreamStreamIdleError(timeoutMs, stream = null, usage = null) {
  const error = new Error(`Upstream response stayed idle for ${timeoutMs} ms.`)
  error.code = UPSTREAM_STREAM_IDLE_CODE
  error.stream = stream
  error.usage = usage
  return error
}

function makeUpstreamPayloadError(message, status = 0) {
  const error = new Error(`Upstream returned an error payload: ${message}`)
  error.code = UPSTREAM_PAYLOAD_FAILED_CODE
  error.upstreamStatus = status
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
    providerId: attempt.providerId,
    providerName: attempt.providerName,
    credentialId: attempt.credentialId || '',
    credentialLabel: attempt.credentialLabel || '',
    model: attempt.model,
    status: attempt.status ?? null,
    latencyMs: attempt.latencyMs ?? null,
    error: attempt.error ? preview(attempt.error) : null,
    outcome: attempt.outcome || '',
    diagnostic: attempt.diagnostic || null,
    reconnectFailureCount: attempt.reconnectFailureCount || 0,
    reconnectFailureThreshold: attempt.reconnectFailureThreshold || 0,
    failoverArmed: Boolean(attempt.failoverArmed),
    reasoningFallback: attempt.reasoningFallback || null,
  }
}

function requestDiagnostics(routingDiagnostics = [], attempts = []) {
  const attemptDiagnostics = attempts.map((attempt, index) => {
    if (!attempt.diagnostic) return null
    return {
      ...attempt.diagnostic,
      providerId: attempt.providerId,
      providerName: attempt.providerName,
      model: attempt.model,
      attempt: index + 1,
    }
  }).filter(Boolean)

  return [...routingDiagnostics, ...attemptDiagnostics]
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
