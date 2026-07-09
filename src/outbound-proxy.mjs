import { spawnSync } from 'node:child_process'

export const OUTBOUND_PROXY_MODES = new Set(['direct', 'system', 'custom'])
export const PROVIDER_OUTBOUND_PROXY_MODES = new Set(['inherit', 'direct', 'system', 'custom'])
export const LOCAL_NO_PROXY = '127.0.0.1,localhost,::1'

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
let cachedSystemProxy = null

export function normalizeOutboundProxyMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return OUTBOUND_PROXY_MODES.has(mode) ? mode : 'direct'
}

export function normalizeProviderOutboundProxyMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return PROVIDER_OUTBOUND_PROXY_MODES.has(mode) ? mode : 'inherit'
}

export function normalizeProxyUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

export function maskProxyUrl(value) {
  const normalized = normalizeProxyUrl(value)
  if (!normalized) return ''

  const url = new URL(normalized)
  if (url.password) url.password = '****'
  return url.toString()
}

export function isMaskedProxyUrl(value) {
  return typeof value === 'string' && value.includes('****')
}

export function getEnvProxy(env = process.env) {
  return normalizeProxyUrl(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '')
}

export function parseWindowsProxyServer(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''

  const parts = raw.split(';').map((item) => item.trim()).filter(Boolean)
  const map = new Map()
  const plain = []

  for (const part of parts.length ? parts : [raw]) {
    const index = part.indexOf('=')
    if (index > 0) {
      map.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim())
    } else {
      plain.push(part)
    }
  }

  return normalizeProxyUrl(map.get('https') || map.get('http') || plain[0] || '')
}

export function detectSystemProxy(env = process.env) {
  const envProxy = getEnvProxy(env)
  if (envProxy) {
    return { url: envProxy, source: 'env', enabled: true }
  }

  const bootstrappedProxy = normalizeProxyUrl(env.RELAY_OUTBOUND_PROXY_DETECTED_URL || '')
  if (bootstrappedProxy) {
    return { url: bootstrappedProxy, source: 'bootstrap', enabled: true }
  }

  return detectWindowsSystemProxy()
}

export function getCachedSystemProxy(env = process.env, ttlMs = 30000) {
  const now = Date.now()
  if (cachedSystemProxy && cachedSystemProxy.expiresAt > now) return cachedSystemProxy.result

  const result = detectSystemProxy(env)
  cachedSystemProxy = { expiresAt: now + ttlMs, result }
  return result
}

export function detectWindowsSystemProxy() {
  if (process.platform !== 'win32') {
    return { url: '', source: 'unsupported_platform', enabled: false }
  }

  const script = [
    "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[PSCustomObject]@{ ProxyEnable = $p.ProxyEnable; ProxyServer = $p.ProxyServer } | ConvertTo-Json -Compress",
  ].join('; ')

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  })

  if (result.error || result.status !== 0) {
    return { url: '', source: 'windows_registry_error', enabled: false }
  }

  try {
    const data = JSON.parse(String(result.stdout || '{}'))
    const enabled = data.ProxyEnable === true || Number(data.ProxyEnable) === 1
    if (!enabled) return { url: '', source: 'none', enabled: false }

    const url = parseWindowsProxyServer(data.ProxyServer)
    return url
      ? { url, source: 'windows_registry', enabled: true }
      : { url: '', source: 'none', enabled: false }
  } catch {
    return { url: '', source: 'windows_registry_parse_error', enabled: false }
  }
}

export function supportsEnvProxyFlag() {
  return Boolean(process.allowedNodeEnvironmentFlags?.has('--use-env-proxy'))
}

export function resolveOutboundProxyPlan(service = {}, env = process.env, options = {}) {
  const configuredMode = normalizeOutboundProxyMode(service.outboundProxyMode)
  const childEnv = { ...env }
  const systemProxy = options.systemProxy || getCachedSystemProxy(env)
  const resolved = resolveServiceOutboundProxy(service, { systemProxy })
  let warning = ''

  if (configuredMode === 'custom' && !resolved.proxyUrl) warning = '自定义代理地址无效，当前按直连工作。'
  if (configuredMode === 'system' && !resolved.proxyUrl) warning = '未检测到系统代理，当前按直连工作。'

  for (const key of PROXY_ENV_KEYS) {
    delete childEnv[key]
  }

  childEnv.RELAY_OUTBOUND_PROXY_BOOTSTRAPPED = '1'
  childEnv.RELAY_OUTBOUND_PROXY_CONFIGURED_MODE = configuredMode
  childEnv.RELAY_OUTBOUND_PROXY_EFFECTIVE_MODE = resolved.effectiveMode
  childEnv.RELAY_OUTBOUND_PROXY_EFFECTIVE_URL = resolved.proxyUrl
  childEnv.RELAY_OUTBOUND_PROXY_DETECTED_URL = systemProxy.url || ''
  childEnv.RELAY_OUTBOUND_PROXY_SOURCE = resolved.proxySource
  childEnv.RELAY_OUTBOUND_PROXY_RUNTIME = '1'

  return {
    configuredMode,
    effectiveMode: resolved.effectiveMode,
    proxyUrl: resolved.proxyUrl,
    detectedProxyUrl: systemProxy.url || '',
    proxySource: resolved.proxySource,
    flagSupported: true,
    useEnvProxy: false,
    warning,
    env: childEnv,
    nodeArgs: [],
  }
}

export function getOutboundRuntime(service = {}, env = process.env, execArgv = process.execArgv, options = {}) {
  const configuredMode = normalizeOutboundProxyMode(service.outboundProxyMode)
  const configuredProxyUrl = configuredMode === 'custom' ? normalizeProxyUrl(service.outboundProxyUrl) : ''
  const launchedConfiguredMode = normalizeOutboundProxyMode(env.RELAY_OUTBOUND_PROXY_CONFIGURED_MODE)
  const bootstrapped = env.RELAY_OUTBOUND_PROXY_BOOTSTRAPPED === '1'
  const flagEnabled = execArgv.includes('--use-env-proxy')
  const systemProxy = options.systemProxy || getCachedSystemProxy(env)
  const resolved = resolveServiceOutboundProxy(service, { systemProxy })

  return {
    configuredMode,
    configuredProxyUrl: maskProxyUrl(configuredProxyUrl),
    effectiveMode: resolved.effectiveMode,
    effectiveProxyUrl: maskProxyUrl(resolved.proxyUrl),
    systemProxyUrl: maskProxyUrl(systemProxy.url || ''),
    proxySource: resolved.proxySource,
    launchedConfiguredMode,
    flagEnabled,
    flagSupported: true,
    bootstrapped,
    needsRestart: false,
    message: outboundRuntimeMessage({
      configuredMode,
      effectiveMode: resolved.effectiveMode,
      needsRestart: false,
      proxySource: resolved.proxySource,
      flagSupported: true,
      effectiveProxyUrl: resolved.proxyUrl,
    }),
  }
}

export function resolveServiceOutboundProxy(service = {}, options = {}) {
  const mode = normalizeOutboundProxyMode(service.outboundProxyMode)
  return resolveProxyByMode(mode, service.outboundProxyUrl, options.systemProxy)
}

export function resolveProviderOutboundProxy(provider = {}, service = {}, options = {}) {
  const providerMode = normalizeProviderOutboundProxyMode(provider.outboundProxyMode)
  if (providerMode === 'inherit') {
    return {
      providerMode,
      inherited: true,
      ...resolveServiceOutboundProxy(service, options),
    }
  }

  return {
    providerMode,
    inherited: false,
    ...resolveProxyByMode(providerMode, provider.outboundProxyUrl, options.systemProxy),
  }
}

export function describeOutboundPlan(plan) {
  if (plan.proxyUrl) {
    return `${plan.effectiveMode} (${maskProxyUrl(plan.proxyUrl)})`
  }
  return 'direct'
}

function outboundRuntimeMessage(detail) {
  if (!detail.flagSupported && detail.configuredMode !== 'direct') return '当前 Node.js 不支持出站代理启动参数。'
  if (detail.needsRestart) return '代理设置已保存，重启程序后生效。'
  if (detail.configuredMode === 'system' && detail.effectiveMode === 'direct' && detail.proxySource === 'none') {
    return '未检测到系统代理，当前按直连工作。'
  }
  if (detail.effectiveMode === 'direct') return '当前出站直连。'
  return '当前出站代理已生效。'
}

function resolveProxyByMode(mode, proxyUrl, systemProxy = null) {
  if (mode === 'custom') {
    const normalized = normalizeProxyUrl(proxyUrl)
    return {
      configuredMode: mode,
      effectiveMode: normalized ? 'custom' : 'direct',
      proxyUrl: normalized,
      proxySource: normalized ? 'custom' : 'invalid_custom',
    }
  }

  if (mode === 'system') {
    const detected = systemProxy || getCachedSystemProxy()
    const normalized = normalizeProxyUrl(detected.url || '')
    return {
      configuredMode: mode,
      effectiveMode: normalized ? 'system' : 'direct',
      proxyUrl: normalized,
      proxySource: normalized ? detected.source || 'system' : 'none',
    }
  }

  return {
    configuredMode: 'direct',
    effectiveMode: 'direct',
    proxyUrl: '',
    proxySource: 'none',
  }
}
