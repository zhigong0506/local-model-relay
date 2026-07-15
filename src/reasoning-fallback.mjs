const MAX_EFFORT = 'max'
const FALLBACK_EFFORT = 'xhigh'

const HIGH_CONFIDENCE_PATTERNS = [
  /unsupported[^\n]{0,80}reasoning[^\n]{0,40}effort/i,
  /invalid[^\n]{0,80}reasoning[^\n]{0,40}effort/i,
  /reasoning[^\n]{0,40}effort[^\n]{0,80}(?:max)[^\n]{0,80}(?:not supported|unsupported|invalid|unavailable)/i,
  /(?:max)[^\n]{0,80}reasoning[^\n]{0,40}effort[^\n]{0,80}(?:not supported|unsupported|invalid|unavailable)/i,
  /codex_model_price_not_configured/i,
]

export function buildReasoningFallback(body, failure = {}) {
  if (requestedReasoningEffort(body) !== MAX_EFFORT) return null

  const status = Number(failure.status) || 0
  const message = String(failure.message || '')
  if (status < 400 || !HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(message))) return null

  return {
    body: replaceReasoningEffort(body, FALLBACK_EFFORT),
    from: MAX_EFFORT,
    to: FALLBACK_EFFORT,
    reason: fallbackReason(message),
  }
}

export function requestedReasoningEffort(body) {
  const nested = body?.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
    ? body.reasoning.effort
    : undefined
  const value = nested ?? body?.reasoning_effort
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function replaceReasoningEffort(body, effort) {
  const next = { ...body }
  if (body?.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
    next.reasoning = { ...body.reasoning, effort }
  }
  if (Object.hasOwn(body || {}, 'reasoning_effort')) next.reasoning_effort = effort
  return next
}

function fallbackReason(message) {
  return /codex_model_price_not_configured/i.test(message)
    ? 'codex_model_price_not_configured'
    : 'reasoning_effort_unsupported'
}
