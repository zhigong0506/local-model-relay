const STATUS_DIAGNOSTICS = new Map([
  [400, {
    code: 'upstream_bad_request',
    title: '请求参数被上游拒绝',
    suggestion: '检查模型名、wire API、请求参数和线路的 Base URL 配置。',
  }],
  [401, {
    code: 'upstream_auth_failed',
    title: '上游鉴权失败',
    suggestion: '检查该线路 Key 是否有效、过期或已被上游停用。',
  }],
  [402, {
    code: 'upstream_quota_exhausted',
    title: '上游额度或余额不足',
    suggestion: '检查上游余额、套餐额度和扣费状态；额度耗尽后请启用其他 Key 或线路。',
  }],
  [403, {
    code: 'upstream_permission_denied',
    title: '上游权限或模型受限',
    suggestion: '检查 Key 的模型权限、账号权限和地区限制，确认线路模型配置正确。',
  }],
  [404, {
    code: 'upstream_not_found',
    title: '上游接口或模型不存在',
    suggestion: '检查 Base URL 是否包含正确的 /v1 路径，以及模型名是否被该站点支持。',
  }],
  [408, {
    code: 'upstream_request_timeout',
    title: '上游请求超时',
    suggestion: '检查上游速度和直连/代理设置；必要时提高该线路超时或切换线路。',
  }],
  [409, {
    code: 'upstream_request_conflict',
    title: '上游请求冲突',
    suggestion: '检查上游并发、会话状态和请求参数，稍后重试。',
  }],
  [425, {
    code: 'upstream_overloaded',
    title: '上游暂时过载',
    suggestion: '稍后重试或降低并发，建议保留备用线路。',
  }],
  [429, {
    code: 'upstream_rate_limited',
    title: '上游触发频率限制',
    suggestion: '降低请求频率或检查上游限流策略，必要时切换 Key 或线路。',
  }],
  [500, {
    code: 'upstream_internal_error',
    title: '上游内部错误',
    suggestion: '检查上游服务状态，记录发生时间和模型后联系站点；也可以切换备用线路。',
  }],
  [502, {
    code: 'upstream_gateway_error',
    title: '上游网关或线路异常',
    suggestion: '检查 Base URL、代理和上游网关状态，确认站点当前可用。',
  }],
  [503, {
    code: 'upstream_unavailable',
    title: '上游服务暂不可用',
    suggestion: '上游可能在维护、过载或额度系统异常；稍后重试并检查备用线路。',
  }],
  [504, {
    code: 'upstream_gateway_timeout',
    title: '上游网关超时',
    suggestion: '检查上游响应速度和代理链路，必要时提高超时或切换线路。',
  }],
])

export function describeUpstreamFailure(status, message = '', outcome = '', options = {}) {
  const numericStatus = Number(status)
  const detail = compactMessage(message)

  if (outcome === 'upstream_payload_failed') {
    return {
      type: 'upstream_error',
      code: 'upstream_payload_error',
      status: Number.isFinite(numericStatus) ? numericStatus : 0,
      title: '上游返回错误包',
      message: detail ? `上游返回了错误内容（HTTP ${formatStatus(numericStatus)}）：${detail}` : `上游返回了错误内容（HTTP ${formatStatus(numericStatus)}）。`,
      suggestion: '该响应虽然可能是 HTTP 200，但内容包含 error/failed 状态；请检查上游兼容性和线路配置。',
    }
  }

  if (outcome === 'upstream_stream_failed') {
    return streamDiagnostic('上游流式响应失败', '上游在输出过程中报告了失败。', detail, '检查上游流式协议、线路稳定性和模型兼容性。', numericStatus)
  }

  if (outcome === 'upstream_stream_incomplete') {
    return streamDiagnostic('上游流式响应未完成', '上游连接提前结束，未收到完成标记。', detail, '检查线路是否中断、上游是否限时，以及代理是否支持长连接。', numericStatus)
  }

  if (outcome === 'upstream_stream_idle_timeout') {
    return streamDiagnostic('上游流式响应超时', '上游在规定时间内没有继续输出。', detail, '检查上游速度和代理链路；必要时提高该线路超时或切换线路。', numericStatus)
  }

  if (options.timedOut || outcome === 'local_timeout') {
    return {
      type: 'upstream_error',
      code: 'network_timeout',
      status: 0,
      title: '网络或本地请求超时',
      message: detail ? `未收到有效的上游 HTTP 响应：${detail}` : '未收到有效的上游 HTTP 响应。',
      suggestion: '检查线路网络、TLS 和直连/系统代理设置；必要时提高线路超时。',
    }
  }

  if (!Number.isFinite(numericStatus) || numericStatus <= 0) {
    return {
      type: 'upstream_error',
      code: 'network_connection_failed',
      status: 0,
      title: '上游网络连接失败',
      message: detail ? `请求没有建立有效连接：${detail}` : '请求没有建立有效连接。',
      suggestion: '检查域名、TLS、直连/系统代理和本机网络；确认上游站点可以从当前网络访问。',
    }
  }

  const preset = STATUS_DIAGNOSTICS.get(numericStatus)
  if (preset) {
    return {
      type: 'upstream_error',
      code: preset.code,
      status: numericStatus,
      title: preset.title,
      message: detail ? `上游返回 HTTP ${numericStatus}：${detail}` : `上游返回 HTTP ${numericStatus}。`,
      suggestion: preset.suggestion,
    }
  }

  return {
    type: 'upstream_error',
    code: `upstream_http_${numericStatus}`,
    status: numericStatus,
    title: `上游返回 HTTP ${numericStatus}`,
    message: detail ? `上游返回 HTTP ${numericStatus}：${detail}` : `上游返回 HTTP ${numericStatus}。`,
    suggestion: numericStatus >= 500
      ? '检查上游服务状态和线路网络，必要时切换备用线路。'
      : '检查模型、请求参数、Key 权限和线路 Base URL 配置。',
  }
}

export function describeRoutingSkip(provider, reason, model = '') {
  const providerName = String(provider?.name || '未命名线路')
  const base = {
    type: 'routing_skip',
    status: 0,
    providerId: provider?.id || '',
    providerName,
    model,
  }

  if (reason === 'no_enabled_key') {
    return {
      ...base,
      code: 'no_enabled_key',
      title: '线路已跳过',
      message: '没有启用且可用的 Key，未参与本次请求。',
      suggestion: '请启用现有 Key 或新增 Key。',
    }
  }

  if (reason === 'provider_disabled') {
    return {
      ...base,
      code: 'provider_disabled',
      title: '线路已停用',
      message: '线路开关处于停用状态，未参与本次请求。',
      suggestion: '确认需要使用时重新启用该线路。',
    }
  }

  if (reason === 'cooldown') {
    return {
      ...base,
      code: 'provider_cooldown',
      title: '线路处于冷却中',
      message: '线路近期失败，暂时没有参与本次请求。',
      suggestion: '等待冷却结束，或检查该线路最近一次失败原因。',
    }
  }

  if (reason === 'unsupported_model') {
    return {
      ...base,
      code: 'provider_model_unsupported',
      title: '线路不支持该模型',
      message: `没有配置模型「${model || '(未指定)'}」，未参与本次请求。`,
      suggestion: '检查线路支持模型列表，或为该模型新增模型路由。',
    }
  }

  return {
    ...base,
    code: 'provider_unavailable',
    title: '线路未参与路由',
    message: '线路当前不满足路由条件。',
    suggestion: '检查线路开关、Key、支持模型和冷却状态。',
  }
}

export function redactSecretText(value, secret) {
  const text = String(value || '')
  const normalizedSecret = String(secret || '').trim()
  if (!normalizedSecret || normalizedSecret.length < 4) return text
  return text.split(normalizedSecret).join('[REDACTED]')
}

function streamDiagnostic(title, fallbackMessage, detail, suggestion, status) {
  return {
    type: 'upstream_error',
    code: title === '上游流式响应失败' ? 'upstream_stream_failed' : title === '上游流式响应未完成' ? 'upstream_stream_incomplete' : 'upstream_stream_timeout',
    status: Number.isFinite(status) && status > 0 ? status : 0,
    title,
    message: detail || fallbackMessage,
    suggestion,
  }
}

function compactMessage(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function formatStatus(status) {
  return Number.isFinite(status) && status > 0 ? String(status) : '未知'
}
