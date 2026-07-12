export function upstreamErrorMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''

  if (payload.error) return errorValueText(payload.error)
  if (payload.response?.error) return errorValueText(payload.response.error)
  if (payload.success === false || payload.ok === false) {
    return errorValueText(payload.message || payload.detail || payload.code) || 'Upstream reported failure.'
  }
  if (payload.type === 'error' || payload.type === 'response.failed' || payload.status === 'failed' || payload.status === 'error') {
    return errorValueText(payload.message || payload.detail || payload.code || payload.response?.status) || 'Upstream reported failure.'
  }
  if (payload.response?.status === 'failed' || payload.response?.status === 'error') {
    return errorValueText(payload.response?.message || payload.response?.detail || payload.response?.code) || 'Upstream reported failure.'
  }
  return ''
}

export function hasCompletionPayload(payload, wireApi = 'chat') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || upstreamErrorMessage(payload)) return false

  if (wireApi === 'responses') {
    return typeof payload.output_text === 'string' ||
      Array.isArray(payload.output) ||
      payload.status === 'completed' ||
      payload.type === 'response.completed' ||
      payload.response?.status === 'completed'
  }

  return Array.isArray(payload.choices) && payload.choices.length > 0
}

function errorValueText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message.trim()) return value.message.trim()
    if (typeof value.detail === 'string' && value.detail.trim()) return value.detail.trim()
    if (typeof value.code === 'string' && value.code.trim()) return value.code.trim()
    try {
      return JSON.stringify(value)
    } catch {}
  }
  return typeof value === 'number' ? String(value) : ''
}
