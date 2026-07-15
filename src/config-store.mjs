import { randomUUID } from 'node:crypto'
import { backupCorruptFile, readJsonFile, writeJsonFile } from './json-file.mjs'
import {
  isMaskedProxyUrl,
  maskProxyUrl,
  normalizeOutboundProxyMode,
  normalizeProviderOutboundProxyMode,
  normalizeProxyUrl,
} from './outbound-proxy.mjs'
import { configPath } from './paths.mjs'

export const DEFAULT_CONFIG = {
  version: 3,
  service: {
    enabled: true,
    listenHost: '127.0.0.1',
    listenPort: 25818,
    localApiKey: 'local-relay',
    requestTimeoutMs: 90000,
    providerTestTimeoutMs: 30000,
    providerRealTestTimeoutMs: 90000,
    retryStatusCodes: [401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
    maxAttempts: 8,
    defaultCooldownSeconds: 60,
    reconnectFailureThreshold: 4,
    reconnectCooldownSeconds: 600,
    sessionAffinity: true,
    sessionTtlSeconds: 86400,
    sessionLimit: 800,
    logRequests: true,
    collectUsage: true,
    collectStreamUsage: true,
    quotaPerCny: 500000,
    requestLogLimit: 1500,
    outboundProxyMode: 'direct',
    outboundProxyUrl: '',
    diagnosticsLlm: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: 30000,
    },
  },
  providerGroups: [
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI 与 OpenAI-compatible 中转线路',
      color: '#7567d8',
      priority: 10,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek 模型与兼容中转线路',
      color: '#159a80',
      priority: 20,
    },
  ],
  providers: [],
  routes: [],
  updatedAt: null,
}

const AUTH_MODES = new Set(['authorization', 'x-api-key', 'both', 'none'])
const WIRE_APIS = new Set(['chat', 'responses', 'auto'])

export class ConfigStore {
  constructor(filePath = configPath) {
    this.filePath = filePath
    this.config = this.load()
    this.persist()
  }

  get() {
    return structuredClone(this.config)
  }

  getPublic() {
    return publicConfig(this.config)
  }

  updateService(patch) {
    const nextPatch = { ...patch }
    if (isMaskedProxyUrl(nextPatch.outboundProxyUrl)) {
      nextPatch.outboundProxyUrl = this.config.service.outboundProxyUrl
    }
    if (isRecord(nextPatch.diagnosticsLlm)) {
      nextPatch.diagnosticsLlm = preserveDiagnosticsLlm(nextPatch.diagnosticsLlm, this.config.service.diagnosticsLlm)
    }
    assertServicePatch(nextPatch)
    this.config.service = normalizeService({ ...this.config.service, ...nextPatch })
    this.touch()
    this.persist()
    return this.getPublic()
  }

  setEnabled(enabled) {
    this.config.service.enabled = Boolean(enabled)
    this.touch()
    this.persist()
    return this.getPublic()
  }

  exportConfig(includeSecrets = false) {
    const config = structuredClone(this.config)
    if (!includeSecrets) {
      config.service.localApiKey = maskSecret(config.service.localApiKey)
      config.service.outboundProxyUrl = maskProxyUrl(config.service.outboundProxyUrl)
      config.service.diagnosticsLlm = publicDiagnosticsLlm(config.service.diagnosticsLlm)
      config.providers = config.providers.map((provider) => ({
        ...provider,
        apiKey: maskSecret(resolveActiveKey(provider)),
        outboundProxyUrl: maskProxyUrl(provider.outboundProxyUrl),
        credentials: provider.credentials.map((credential) => ({
          ...credential,
          apiKey: maskSecret(credential.apiKey),
        })),
      }))
    }

    return {
      app: 'local-model-relay',
      version: 3,
      exportedAt: new Date().toISOString(),
      includesSecrets: Boolean(includeSecrets),
      config,
    }
  }

  importConfig(input) {
    const payload = isRecord(input?.config) ? structuredClone(input.config) : structuredClone(input)
    if (!isRecord(payload)) throw new HttpError(400, 'invalid_import', 'Import payload must contain a config object.')

    const currentProviders = new Map(this.config.providers.map((provider) => [provider.id, provider]))
    payload.service = isRecord(payload.service) ? payload.service : {}
    if (isMaskedOrEmpty(payload.service.localApiKey)) {
      payload.service.localApiKey = this.config.service.localApiKey
    }
    if (isMaskedProxyUrl(payload.service.outboundProxyUrl)) {
      payload.service.outboundProxyUrl = this.config.service.outboundProxyUrl
    }
    payload.service.diagnosticsLlm = preserveDiagnosticsLlm(
      payload.service.diagnosticsLlm,
      this.config.service.diagnosticsLlm,
    )

    if (Array.isArray(payload.providers)) {
      payload.providers = payload.providers.map((provider) => {
        if (!isRecord(provider)) return provider
        const existing = currentProviders.get(provider.id)
        return preserveProviderSecrets(provider, existing)
      })
    }

    const nextConfig = normalizeConfig(payload)
    assertUniqueRouteModels(nextConfig.routes)
    this.config = nextConfig
    syncRoutesWithProviders(this.config)
    this.touch()
    this.persist()
    return this.getPublic()
  }

  setActiveCredential(providerId, credentialId) {
    const provider = this.config.providers.find((item) => item.id === providerId)
    if (!provider) throw new HttpError(404, 'provider_not_found', 'Provider not found.')

    const credential = provider.credentials.find((item) => item.id === credentialId)
    if (!credential) throw new HttpError(404, 'credential_not_found', 'Credential not found.')
    if (!credential.enabled) throw new HttpError(400, 'credential_disabled', 'Credential is disabled.')

    provider.activeCredentialId = credential.id
    provider.updatedAt = new Date().toISOString()
    this.touch()
    this.persist()
    return publicProvider(provider)
  }

  createProviderGroup(input) {
    const name = toText(input?.name, '')
    if (!name) throw new HttpError(400, 'invalid_provider_group', 'Provider group name is required.')
    assertUniqueProviderGroupName(this.config.providerGroups, name)
    const group = normalizeProviderGroup({
      ...input,
      id: randomUUID(),
      priority: nextProviderGroupPriority(this.config.providerGroups),
      name,
    })
    this.config.providerGroups.push(group)
    this.touch()
    this.persist()
    return structuredClone(group)
  }

  updateProviderGroup(id, input) {
    const index = this.config.providerGroups.findIndex((group) => group.id === id)
    if (index < 0) throw new HttpError(404, 'provider_group_not_found', 'Provider group not found.')

    const existing = this.config.providerGroups[index]
    const name = input?.name === undefined ? existing.name : toText(input.name, '')
    if (!name) throw new HttpError(400, 'invalid_provider_group', 'Provider group name is required.')
    assertUniqueProviderGroupName(this.config.providerGroups, name, id)
    const next = normalizeProviderGroup({ ...existing, ...input, id, name })
    this.config.providerGroups[index] = next
    this.touch()
    this.persist()
    return structuredClone(next)
  }

  deleteProviderGroup(id) {
    const group = this.config.providerGroups.find((item) => item.id === id)
    if (!group) throw new HttpError(404, 'provider_group_not_found', 'Provider group not found.')
    if (this.config.providerGroups.length <= 1) {
      throw new HttpError(409, 'last_provider_group', 'At least one provider group must be kept.')
    }
    const providerCount = this.config.providers.filter((provider) => provider.groupId === id).length
    if (providerCount > 0) {
      throw new HttpError(409, 'provider_group_not_empty', `Move the ${providerCount} provider(s) in this group before deleting it.`)
    }

    this.config.providerGroups = this.config.providerGroups.filter((item) => item.id !== id)
    this.touch()
    this.persist()
    return this.getPublic()
  }

  updateProviderCapabilities(providerId, capabilities = {}) {
    const provider = this.config.providers.find((item) => item.id === providerId)
    if (!provider) throw new HttpError(404, 'provider_not_found', 'Provider not found.')

    provider.capabilities = normalizeCapabilities(capabilities)
    provider.updatedAt = new Date().toISOString()
    this.touch()
    this.persist()
    return publicProvider(provider)
  }

  createProvider(input) {
    const groupId = resolveProviderGroupId(input?.groupId, this.config.providerGroups, true)
    const rawProvider = {
      id: randomUUID(),
      enabled: true,
      priority: nextPriority(this.config.providers),
      authMode: 'authorization',
      wireApi: 'chat',
      outboundProxyMode: 'inherit',
      outboundProxyUrl: '',
      timeoutMs: this.config.service.requestTimeoutMs,
      cooldownSeconds: this.config.service.defaultCooldownSeconds,
      models: [],
      tags: [],
      notes: '',
      capabilities: {},
      ...input,
      groupId,
    }
    assertProviderPatch(rawProvider)
    const provider = normalizeProvider(rawProvider)

    this.config.providers.push(provider)
    syncRoutesWithProviders(this.config)
    this.touch()
    this.persist()
    return publicProvider(provider)
  }

  updateProvider(id, input) {
    const index = this.config.providers.findIndex((provider) => provider.id === id)
    if (index < 0) throw new HttpError(404, 'provider_not_found', 'Provider not found.')

    const existing = this.config.providers[index]
    const preservedInput = preserveProviderSecrets({
      ...input,
      groupId: input?.groupId === undefined
        ? existing.groupId
        : resolveProviderGroupId(input.groupId, this.config.providerGroups, true),
    }, existing)
    assertProviderPatch(preservedInput)
    const next = normalizeProvider({
      ...existing,
      ...preservedInput,
      apiKey: preservedInput.apiKey === undefined || preservedInput.apiKey === '' ? resolveActiveKey(existing) : preservedInput.apiKey,
      id: existing.id,
    })

    this.config.providers[index] = next
    syncRoutesWithProviders(this.config)
    this.touch()
    this.persist()
    return publicProvider(next)
  }

  deleteProvider(id) {
    const before = this.config.providers.length
    this.config.providers = this.config.providers.filter((provider) => provider.id !== id)
    this.config.routes = this.config.routes
      .map((route) => ({
        ...route,
        targets: route.targets.filter((target) => target.providerId !== id),
      }))
      .filter((route) => route.targets.length > 0)
    syncRoutesWithProviders(this.config)

    if (this.config.providers.length === before) {
      throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    }

    this.touch()
    this.persist()
    return this.getPublic()
  }

  createRoute(input) {
    const route = normalizeRoute({
      id: randomUUID(),
      enabled: true,
      targets: [],
      notes: '',
      ...input,
    }, this.config.providers)

    assertUniqueRouteModel(this.config.routes, route.virtualModel)

    this.config.routes.push(route)
    syncRoutesWithProviders(this.config)
    this.touch()
    this.persist()
    return publicRoute(this.config.routes.at(-1), this.config.providers)
  }

  updateRoute(id, input) {
    const index = this.config.routes.findIndex((route) => route.id === id)
    if (index < 0) throw new HttpError(404, 'route_not_found', 'Route not found.')

    const existing = this.config.routes[index]
    const route = normalizeRoute({ ...existing, ...input, id: existing.id }, this.config.providers)
    assertUniqueRouteModel(this.config.routes, route.virtualModel, existing.id)
    this.config.routes[index] = route
    syncRoutesWithProviders(this.config)
    this.touch()
    this.persist()
    return publicRoute(this.config.routes[index], this.config.providers)
  }

  deleteRoute(id) {
    const before = this.config.routes.length
    this.config.routes = this.config.routes.filter((route) => route.id !== id)
    if (this.config.routes.length === before) {
      throw new HttpError(404, 'route_not_found', 'Route not found.')
    }

    this.touch()
    this.persist()
    return this.getPublic()
  }

  load() {
    try {
      return normalizeConfig(readJsonFile(this.filePath, DEFAULT_CONFIG))
    } catch (error) {
      backupCorruptFile(this.filePath, error instanceof Error ? error.message : String(error))
      return normalizeConfig(DEFAULT_CONFIG)
    }
  }

  touch() {
    this.config.updatedAt = new Date().toISOString()
  }

  persist() {
    writeJsonFile(this.filePath, this.config)
  }
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function publicConfig(config) {
  const providers = config.providers.map(publicProvider)
  return {
    ...structuredClone(config),
    service: publicService(config.service),
    providers,
    routes: config.routes.map((route) => publicRoute(route, config.providers)),
  }
}

function publicService(service) {
  const clone = structuredClone(service)
  return {
    ...clone,
    outboundProxyUrl: maskProxyUrl(service.outboundProxyUrl),
    diagnosticsLlm: publicDiagnosticsLlm(service.diagnosticsLlm),
  }
}

function publicDiagnosticsLlm(value) {
  const diagnosticsLlm = normalizeDiagnosticsLlm(value)
  return {
    ...diagnosticsLlm,
    apiKey: '',
    apiKeySet: Boolean(diagnosticsLlm.apiKey),
    apiKeyMasked: maskSecret(diagnosticsLlm.apiKey),
  }
}

export function publicProvider(provider) {
  const clone = { ...provider }
  delete clone.apiKey
  clone.outboundProxyUrl = maskProxyUrl(provider.outboundProxyUrl)
  clone.credentials = provider.credentials.map((credential) => ({
    id: credential.id,
    label: credential.label,
    enabled: credential.enabled,
    note: credential.note,
    rate: credential.rate,
    upstreamGroup: credential.upstreamGroup,
    upstreamStatus: credential.upstreamStatus,
    apiKeySet: Boolean(credential.apiKey),
    apiKeyMasked: maskSecret(credential.apiKey),
  }))
  const active = resolveActiveCredential(provider)
  clone.activeCredentialLabel = active?.label || ''
  clone.apiKeySet = Boolean(resolveActiveKey(provider))
  clone.apiKeyMasked = maskSecret(resolveActiveKey(provider))
  return clone
}

export function publicRoute(route, providers) {
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]))
  return {
    ...structuredClone(route),
    targets: route.targets.map((target) => ({
      ...target,
      providerName: providerNames.get(target.providerId) || 'Missing provider',
    })),
  }
}

export function maskSecret(value) {
  if (!value) return ''
  if (value.length <= 8) return `${value.slice(0, 2)}****`
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

function isMaskedOrEmpty(value) {
  return typeof value !== 'string' || !value.trim() || value.includes('****')
}

function preserveProviderSecrets(input, existing) {
  if (!existing) return input
  const next = { ...input }

  if (isMaskedOrEmpty(next.apiKey)) {
    next.apiKey = resolveActiveKey(existing)
  }

  if (isMaskedProxyUrl(next.outboundProxyUrl)) {
    next.outboundProxyUrl = existing.outboundProxyUrl || ''
  }

  if (Array.isArray(next.credentials)) {
    const existingCredentials = new Map(existing.credentials.map((credential) => [credential.id, credential]))
    next.credentials = next.credentials.map((credential) => {
      if (!isRecord(credential)) return credential
      const old = existingCredentials.get(credential.id)
      if (isMaskedOrEmpty(credential.apiKey)) {
        return { ...credential, apiKey: old?.apiKey || '' }
      }
      return credential
    })
  }

  return next
}

export function resolveActiveKey(provider) {
  const credentials = Array.isArray(provider.credentials) ? provider.credentials : []
  const active =
    credentials.find((credential) => credential.id === provider.activeCredentialId && credential.enabled) ||
    credentials.find((credential) => credential.enabled) ||
    null
  if (active) return active.apiKey || ''
  // A legacy provider may have no credentials array at all. Once credentials
  // exist, all-disabled means intentionally unavailable and must not fall back
  // to a disabled credential or a stale provider.apiKey value.
  return credentials.length === 0 && typeof provider.apiKey === 'string' ? provider.apiKey : ''
}

export function resolveActiveCredential(provider) {
  const credentials = Array.isArray(provider.credentials) ? provider.credentials : []
  return (
    credentials.find((credential) => credential.id === provider.activeCredentialId && credential.enabled) ||
    credentials.find((credential) => credential.enabled) ||
    null
  )
}

function normalizeConfig(value) {
  if (!isRecord(value)) throw new Error('config must be an object')
  const providerGroups = normalizeProviderGroups(value.providerGroups)
  const groupIds = new Set(providerGroups.map((group) => group.id))
  const fallbackGroupId = groupIds.has('openai') ? 'openai' : providerGroups[0].id
  const providers = Array.isArray(value.providers)
    ? value.providers.map((provider) => normalizeProvider({
      ...provider,
      groupId: groupIds.has(toText(provider?.groupId, '')) ? provider.groupId : fallbackGroupId,
    }))
    : []
  const config = {
    version: 3,
    service: normalizeService({ ...DEFAULT_CONFIG.service, ...value.service }),
    providerGroups,
    providers,
    routes: Array.isArray(value.routes)
      ? value.routes.map((route) => normalizeRoute(route, providers))
      : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
  syncRoutesWithProviders(config)
  return config
}

function normalizeService(input) {
  const listenPort = clampInteger(input.listenPort, 1, 65535, DEFAULT_CONFIG.service.listenPort)
  const requestTimeoutMs = toPositiveInteger(input.requestTimeoutMs, DEFAULT_CONFIG.service.requestTimeoutMs)
  const providerTestTimeoutMs = clampInteger(
    input.providerTestTimeoutMs,
    3000,
    120000,
    DEFAULT_CONFIG.service.providerTestTimeoutMs,
  )
  const providerRealTestTimeoutMs = clampInteger(
    input.providerRealTestTimeoutMs,
    5000,
    300000,
    DEFAULT_CONFIG.service.providerRealTestTimeoutMs,
  )
  const maxAttempts = toPositiveInteger(input.maxAttempts, DEFAULT_CONFIG.service.maxAttempts)
  const defaultCooldownSeconds = toNonNegativeInteger(
    input.defaultCooldownSeconds,
    DEFAULT_CONFIG.service.defaultCooldownSeconds,
  )
  const reconnectFailureThreshold = clampInteger(
    input.reconnectFailureThreshold,
    1,
    20,
    DEFAULT_CONFIG.service.reconnectFailureThreshold,
  )
  const reconnectCooldownSeconds = clampInteger(
    input.reconnectCooldownSeconds,
    30,
    10800,
    DEFAULT_CONFIG.service.reconnectCooldownSeconds,
  )
  const sessionTtlSeconds = clampInteger(
    input.sessionTtlSeconds,
    300,
    604800,
    DEFAULT_CONFIG.service.sessionTtlSeconds,
  )
  const sessionLimit = clampInteger(
    input.sessionLimit,
    50,
    10000,
    DEFAULT_CONFIG.service.sessionLimit,
  )
  const outboundProxyMode = normalizeOutboundProxyMode(input.outboundProxyMode)
  const outboundProxyUrl = normalizeProxyUrl(input.outboundProxyUrl)
  const diagnosticsLlm = normalizeDiagnosticsLlm(input.diagnosticsLlm)

  return {
    enabled: input.enabled !== false,
    listenHost: toText(input.listenHost, '127.0.0.1'),
    listenPort,
    localApiKey: toText(input.localApiKey, DEFAULT_CONFIG.service.localApiKey),
    requestTimeoutMs,
    providerTestTimeoutMs,
    providerRealTestTimeoutMs,
    retryStatusCodes: normalizeStatusCodes(input.retryStatusCodes),
    maxAttempts,
    defaultCooldownSeconds,
    reconnectFailureThreshold,
    reconnectCooldownSeconds,
    sessionAffinity: input.sessionAffinity !== false,
    sessionTtlSeconds,
    sessionLimit,
    logRequests: input.logRequests !== false,
    collectUsage: input.collectUsage !== false,
    collectStreamUsage: input.collectStreamUsage !== false,
    quotaPerCny: toPositiveNumber(input.quotaPerCny, DEFAULT_CONFIG.service.quotaPerCny),
    requestLogLimit: clampInteger(input.requestLogLimit, 200, 3000, DEFAULT_CONFIG.service.requestLogLimit),
    outboundProxyMode: outboundProxyMode === 'custom' && !outboundProxyUrl ? 'direct' : outboundProxyMode,
    outboundProxyUrl,
    diagnosticsLlm,
  }
}

function assertServicePatch(patch) {
  const mode = normalizeOutboundProxyMode(patch.outboundProxyMode)
  if (mode === 'custom' && !normalizeProxyUrl(patch.outboundProxyUrl)) {
    throw new HttpError(400, 'invalid_service', 'Custom outbound proxy URL must start with http:// or https://.')
  }
  if (isRecord(patch.diagnosticsLlm)) {
    const baseUrl = toText(patch.diagnosticsLlm.baseUrl, '')
    if (baseUrl && !isHttpUrl(baseUrl)) {
      throw new HttpError(400, 'invalid_diagnostics_llm', 'AI diagnostics URL must start with http:// or https://.')
    }
  }
}

function normalizeDiagnosticsLlm(input) {
  const value = isRecord(input) ? input : {}
  const baseUrl = toText(value.baseUrl, '')
  return {
    enabled: value.enabled === true,
    baseUrl: isHttpUrl(baseUrl) ? trimTrailingSlash(baseUrl) : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    model: toText(value.model, ''),
    timeoutMs: clampInteger(value.timeoutMs, 5000, 120000, DEFAULT_CONFIG.service.diagnosticsLlm.timeoutMs),
  }
}

function preserveDiagnosticsLlm(input, existing) {
  const next = isRecord(input) ? { ...input } : {}
  if (next.clearApiKey === true) {
    next.apiKey = ''
  } else if (isMaskedOrEmpty(next.apiKey)) {
    next.apiKey = existing?.apiKey || ''
  }
  delete next.clearApiKey
  return next
}

function assertProviderPatch(patch) {
  const mode = normalizeProviderOutboundProxyMode(patch.outboundProxyMode)
  if (mode === 'custom' && !normalizeProxyUrl(patch.outboundProxyUrl)) {
    throw new HttpError(400, 'invalid_provider', 'Custom outbound proxy URL must start with http:// or https://.')
  }
}

function normalizeProvider(input) {
  if (!isRecord(input)) throw new Error('provider must be an object')

  const name = toText(input.name, '')
  const baseUrl = toText(input.baseUrl, '')
  if (!name) throw new HttpError(400, 'invalid_provider', 'Provider name is required.')
  if (!isHttpUrl(baseUrl)) throw new HttpError(400, 'invalid_provider', 'Provider base URL must start with http:// or https://.')

  const authMode = toText(input.authMode, 'authorization')
  if (!AUTH_MODES.has(authMode)) {
    throw new HttpError(400, 'invalid_provider', 'Invalid auth mode.')
  }
  const wireApi = toText(input.wireApi, 'chat')
  if (!WIRE_APIS.has(wireApi)) {
    throw new HttpError(400, 'invalid_provider', 'Invalid wire API.')
  }

  const credentials = normalizeCredentials(input)
  const activeCredentialId = selectActiveCredentialId(credentials, toText(input.activeCredentialId, ''))
  const outboundProxyMode = normalizeProviderOutboundProxyMode(input.outboundProxyMode)
  const outboundProxyUrl = normalizeProxyUrl(input.outboundProxyUrl)

  return {
    id: toText(input.id, randomUUID()),
    groupId: toText(input.groupId, 'openai'),
    name,
    baseUrl: trimTrailingSlash(baseUrl),
    apiKey: resolveActiveKey({ credentials, activeCredentialId }),
    credentials,
    activeCredentialId,
    authMode,
    wireApi,
    outboundProxyMode: outboundProxyMode === 'custom' && !outboundProxyUrl ? 'inherit' : outboundProxyMode,
    outboundProxyUrl,
    capabilities: normalizeCapabilities(input.capabilities),
    enabled: input.enabled !== false,
    priority: toNonNegativeInteger(input.priority, 100),
    timeoutMs: clampInteger(input.timeoutMs, 5000, 300000, DEFAULT_CONFIG.service.requestTimeoutMs),
    cooldownSeconds: toNonNegativeInteger(input.cooldownSeconds, DEFAULT_CONFIG.service.defaultCooldownSeconds),
    models: normalizeStringList(input.models),
    tags: normalizeStringList(input.tags),
    notes: toText(input.notes, ''),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function normalizeProviderGroups(value) {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : DEFAULT_CONFIG.providerGroups
  const groups = []
  const seenIds = new Set()
  const seenNames = new Set()

  for (const item of source) {
    if (!isRecord(item)) continue
    const group = normalizeProviderGroup(item)
    const nameKey = group.name.toLocaleLowerCase()
    if (seenIds.has(group.id) || seenNames.has(nameKey)) continue
    seenIds.add(group.id)
    seenNames.add(nameKey)
    groups.push(group)
  }

  if (groups.length === 0) return DEFAULT_CONFIG.providerGroups.map(normalizeProviderGroup)
  return groups.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
}

function normalizeProviderGroup(input) {
  return {
    id: toText(input.id, randomUUID()),
    name: toText(input.name, '未命名分组'),
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 240) : '',
    color: normalizeProviderGroupColor(input.color),
    priority: toNonNegativeInteger(input.priority, 100),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function normalizeProviderGroupColor(value) {
  const color = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#667085'
}

function resolveProviderGroupId(value, groups, strict = false) {
  const requested = toText(value, '')
  if (requested && groups.some((group) => group.id === requested)) return requested
  if (strict && requested) throw new HttpError(400, 'invalid_provider_group', 'Selected provider group does not exist.')
  return groups.find((group) => group.id === 'openai')?.id || groups[0]?.id || 'openai'
}

function assertUniqueProviderGroupName(groups, name, exceptId = '') {
  const normalized = name.trim().toLocaleLowerCase()
  if (groups.some((group) => group.id !== exceptId && group.name.trim().toLocaleLowerCase() === normalized)) {
    throw new HttpError(409, 'duplicate_provider_group', `A provider group named "${name}" already exists.`)
  }
}

function nextProviderGroupPriority(groups) {
  if (!groups.length) return 10
  return Math.max(...groups.map((group) => Number(group.priority) || 0)) + 10
}

function normalizeCredentials(input) {
  let credentials = Array.isArray(input.credentials)
    ? input.credentials.map(normalizeCredential).filter(Boolean)
    : []

  if (credentials.length === 0 && typeof input.apiKey === 'string' && input.apiKey.trim()) {
    credentials = [normalizeCredential({
      id: randomUUID(),
      label: '默认',
      apiKey: input.apiKey.trim(),
      enabled: true,
      note: '',
    })]
  }

  if (credentials.length === 0) {
    credentials = [normalizeCredential({
      id: randomUUID(),
      label: '默认',
      apiKey: '',
      enabled: true,
      note: '',
    })]
  }

  return credentials
}

function normalizeCredential(input) {
  if (!isRecord(input)) return null
  return {
    id: toText(input.id, randomUUID()),
    label: toText(input.label, '默认'),
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    enabled: input.enabled !== false,
    note: toText(input.note, ''),
    rate: toPositiveNumber(input.rate, 1),
    upstreamGroup: toText(input.upstreamGroup, ''),
    upstreamStatus: toText(input.upstreamStatus, ''),
  }
}

function selectActiveCredentialId(credentials, preferredId = '') {
  const preferred = credentials.find((credential) => credential.id === preferredId && credential.enabled)
  if (preferred) return preferred.id
  const enabled = credentials.find((credential) => credential.enabled)
  return enabled?.id || ''
}

function normalizeRoute(input, providers) {
  if (!isRecord(input)) throw new Error('route must be an object')
  const virtualModel = toText(input.virtualModel, '')
  if (!virtualModel) throw new HttpError(400, 'invalid_route', 'Virtual model is required.')

  const providerIds = new Set(providers.map((provider) => provider.id).filter(Boolean))
  const targets = Array.isArray(input.targets)
    ? input.targets
        .map((target, index) => normalizeTarget(target, index))
        .filter((target) => providerIds.size === 0 || providerIds.has(target.providerId))
    : []

  if (targets.length === 0) {
    throw new HttpError(400, 'invalid_route', 'Route needs at least one provider target.')
  }

  return {
    id: toText(input.id, randomUUID()),
    enabled: input.enabled !== false,
    virtualModel,
    targets,
    notes: toText(input.notes, ''),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function normalizeTarget(input, index) {
  if (!isRecord(input)) throw new HttpError(400, 'invalid_route', 'Route target must be an object.')
  const providerId = toText(input.providerId, '')
  const model = toText(input.model, '')
  if (!providerId || !model) {
    throw new HttpError(400, 'invalid_route', 'Every route target needs provider and model.')
  }

  return {
    providerId,
    model,
    priority: toNonNegativeInteger(input.priority, index),
  }
}

function assertUniqueRouteModels(routes) {
  const seen = new Set()
  for (const route of routes) {
    if (seen.has(route.virtualModel)) {
      throw new HttpError(409, 'duplicate_route_model', `A route for virtual model "${route.virtualModel}" already exists.`)
    }
    seen.add(route.virtualModel)
  }
}

function assertUniqueRouteModel(routes, virtualModel, exceptRouteId = '') {
  if (routes.some((route) => route.id !== exceptRouteId && route.virtualModel === virtualModel)) {
    throw new HttpError(409, 'duplicate_route_model', `A route for virtual model "${virtualModel}" already exists.`)
  }
}

function syncRoutesWithProviders(config) {
  const providers = [...config.providers].sort(compareProviders)
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))

  config.routes = config.routes.map((route) => {
    const targetByKey = new Map()
    const providersAlreadyTargeted = new Set()

    for (const target of route.targets) {
      const provider = providerById.get(target.providerId)
      if (!provider) continue
      const key = `${target.providerId}\u0000${target.model}`
      if (targetByKey.has(key)) continue
      providersAlreadyTargeted.add(target.providerId)
      targetByKey.set(key, {
        ...target,
        priority: provider.priority,
      })
    }

    for (const provider of providers) {
      if (providersAlreadyTargeted.has(provider.id)) continue
      if (!provider.models.includes(route.virtualModel)) continue
      targetByKey.set(`${provider.id}\u0000${route.virtualModel}`, {
        providerId: provider.id,
        model: route.virtualModel,
        priority: provider.priority,
      })
    }

    const targets = [...targetByKey.values()].sort((a, b) => {
      const providerA = providerById.get(a.providerId)
      const providerB = providerById.get(b.providerId)
      return compareProviders(providerA, providerB) || a.model.localeCompare(b.model)
    })

    return {
      ...route,
      targets,
    }
  })
}

function compareProviders(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.priority - b.priority || a.name.localeCompare(b.name)
}

function normalizeStatusCodes(value) {
  const codes = normalizeStringList(value)
    .map((item) => Number(item))
    .filter((code) => Number.isInteger(code) && code >= 400 && code <= 599)

  return [...new Set(codes.length > 0 ? codes : DEFAULT_CONFIG.service.retryStatusCodes)]
}

function normalizeCapabilities(value) {
  if (!isRecord(value)) return {}
  const codex = isRecord(value.codex) ? value.codex : null
  if (!codex) return {}
  const rawModels = isRecord(codex.models) ? codex.models : {}
  const models = {}
  for (const [model, result] of Object.entries(rawModels)) {
    if (!isRecord(result) || !model.trim()) continue
    models[model.trim()] = {
      status: ['verified', 'failed', 'unknown'].includes(result.status) ? result.status : 'unknown',
      checkedAt: typeof result.checkedAt === 'string' ? result.checkedAt : null,
      credentialId: toText(result.credentialId, ''),
      wireApi: toText(result.wireApi, 'responses'),
      message: toText(result.message, ''),
      checks: isRecord(result.checks) ? structuredClone(result.checks) : {},
    }
  }
  return { codex: { models } }
}

function normalizeStringList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\n,]/)
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))]
}

function nextPriority(providers) {
  if (!providers.length) return 10
  return Math.max(...providers.map((provider) => Number(provider.priority) || 0)) + 10
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function toText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function toPositiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function toPositiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
