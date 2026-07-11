import { backupCorruptFile, readJsonFile, writeJsonFile } from './json-file.mjs'
import { statePath } from './paths.mjs'
import {
  USAGE_SCHEMA_VERSION,
  addUsage,
  addWindowUsage,
  createUsageState,
  emptyUsageBucket,
  hourKeyFor,
  pruneDailyUsage,
  pruneHourly,
} from './usage.mjs'

const EMPTY_STATE = {
  version: 1,
  providerState: {},
  routing: {
    startProviderId: '',
    startMode: 'auto',
    updatedAt: null,
  },
  requestLog: [],
  usage: createUsageState(),
  upstreamUsage: {},
  startedAt: null,
}

const DEFAULT_REQUEST_LOG_LIMIT = 1500
const ROUTING_START_MODES = new Set(['auto', 'locked'])

export class StateStore {
  constructor(filePath = statePath) {
    this.filePath = filePath
    this.state = this.load()
    this.state.startedAt = new Date().toISOString()
    this.persist()
  }

  getPublic() {
    return structuredClone(this.state)
  }

  getProviderState(providerId) {
    return this.ensureProvider(providerId)
  }

  getStartProviderId() {
    return this.state.routing?.startProviderId || ''
  }

  setStartProvider(providerId, mode) {
    const startProviderId = toText(providerId)
    const current = normalizeRouting(this.state.routing)
    this.state.routing = {
      startProviderId,
      startMode: mode === undefined ? current.startMode : normalizeStartMode(mode),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    return structuredClone(this.state.routing)
  }

  advanceStartProvider(providerId) {
    const current = normalizeRouting(this.state.routing)
    if (current.startMode !== 'auto') return structuredClone(current)

    const startProviderId = toText(providerId)
    if (!startProviderId || current.startProviderId === startProviderId) return structuredClone(current)

    this.state.routing = {
      startProviderId,
      startMode: 'auto',
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    return structuredClone(this.state.routing)
  }

  clearStartProvider() {
    const current = normalizeRouting(this.state.routing)
    this.state.routing = {
      startProviderId: '',
      startMode: current.startMode,
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    return structuredClone(this.state.routing)
  }

  isCooling(providerId, now = Date.now()) {
    return this.ensureProvider(providerId).cooldownUntil > now
  }

  markAttempt(providerId, now = Date.now()) {
    const entry = this.ensureProvider(providerId)
    entry.lastAttemptAt = now
    entry.updatedAt = now
    this.persist()
  }

  markSuccess(providerId, detail = {}, now = Date.now()) {
    const entry = this.ensureProvider(providerId)
    const latencyMs = detail.latencyMs ?? null
    entry.successCount += 1
    entry.consecutiveFailures = 0
    entry.reconnectFailureCount = 0
    entry.lastReconnectFailureAt = null
    entry.cooldownUntil = 0
    entry.lastStatus = detail.status || 200
    entry.lastError = null
    entry.lastLatencyMs = latencyMs
    if (latencyMs !== null) {
      entry.averageLatencyMs = entry.averageLatencyMs === null
        ? latencyMs
        : Math.round(entry.averageLatencyMs * 0.8 + latencyMs * 0.2)
    }
    entry.lastSuccessAt = now
    entry.updatedAt = now
    this.persist()
  }

  markFailure(providerId, detail = {}, now = Date.now()) {
    const entry = this.ensureProvider(providerId)
    entry.failureCount += 1
    entry.consecutiveFailures += 1
    entry.reconnectFailureCount = 0
    entry.lastReconnectFailureAt = null
    entry.lastStatus = detail.status || null
    entry.lastError = detail.message || 'Upstream request failed.'
    entry.lastLatencyMs = detail.latencyMs ?? null
    entry.lastFailureAt = now

    const cooldownSeconds = Number(detail.cooldownSeconds) || 0
    if (cooldownSeconds > 0) {
      entry.cooldownUntil = now + cooldownSeconds * 1000
    }

    entry.updatedAt = now
    this.persist()
  }

  markReconnectFailure(providerId, detail = {}, now = Date.now()) {
    const entry = this.ensureProvider(providerId)
    const threshold = clampPositiveInteger(detail.threshold, 1, 20, 4)
    const windowMs = clampPositiveInteger(detail.windowSeconds, 30, 3600, 300) * 1000
    const previousAt = Number(entry.lastReconnectFailureAt || 0)
    const withinWindow = previousAt > 0 && now - previousAt <= windowMs

    entry.reconnectFailureCount = withinWindow
      ? Number(entry.reconnectFailureCount || 0) + 1
      : 1
    entry.lastReconnectFailureAt = now
    entry.lastStatus = detail.status || null
    entry.lastError = detail.message || 'Client reconnect failed before the upstream response completed.'
    entry.lastLatencyMs = detail.latencyMs ?? null
    entry.updatedAt = now

    const tripped = entry.reconnectFailureCount >= threshold
    if (tripped) {
      entry.failureCount += 1
      entry.consecutiveFailures += 1
      entry.lastFailureAt = now
      entry.cooldownUntil = now + clampPositiveInteger(detail.cooldownSeconds, 30, 10800, 600) * 1000
      entry.reconnectFailureCount = 0
      entry.lastReconnectFailureAt = null
    }

    this.persist()
    return {
      tripped,
      count: tripped ? threshold : entry.reconnectFailureCount,
      threshold,
      cooldownUntil: entry.cooldownUntil,
    }
  }

  addRequestLog(entry, limit = DEFAULT_REQUEST_LOG_LIMIT) {
    const normalizedLimit = normalizeRequestLogLimit(limit)
    this.state.requestLog.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: new Date().toISOString(),
      ...entry,
    })
    this.state.requestLog = this.state.requestLog.slice(0, normalizedLimit)
    this.persist()
  }

  recordUsage(providerId, model, usage, detail = {}, now = Date.now()) {
    if (!usage) return null

    const dateKey = localDateKeyFor(now)
    const latencyMs = Number(detail.latencyMs)
    const modelKey = model || '(unknown)'
    if (!this.state.usage.dimensionStartAt) this.state.usage.dimensionStartAt = now
    this.state.usage.totals = addUsage(this.state.usage.totals, usage)
    this.state.usage.byProvider[providerId] = addUsage(this.state.usage.byProvider[providerId], usage)
    if (detail.credentialId) {
      this.state.usage.byCredential[detail.credentialId] = addUsage(this.state.usage.byCredential[detail.credentialId], usage)
    }
    this.state.usage.byModel[modelKey] = addUsage(this.state.usage.byModel[modelKey], usage)
    this.state.usage.daily[dateKey] = addUsage(this.state.usage.daily[dateKey], usage)
    this.state.usage.daily = pruneDailyUsage(this.state.usage.daily, 90)

    const hourKey = hourKeyFor(now)
    this.state.usage.providerHourly[providerId] = addHourlyDimension(
      this.state.usage.providerHourly[providerId],
      hourKey,
      usage,
      latencyMs,
    )
    this.state.usage.modelHourly[modelKey] = addHourlyDimension(
      this.state.usage.modelHourly[modelKey],
      hourKey,
      usage,
    )
    this.state.usage.dailyByProvider[providerId] = addDailyWindowDimension(
      this.state.usage.dailyByProvider[providerId],
      dateKey,
      usage,
      latencyMs,
    )
    this.state.usage.dailyByModel[modelKey] = addDailyDimension(
      this.state.usage.dailyByModel[modelKey],
      dateKey,
      usage,
    )

    this.persist()
    return usage
  }

  recordUpstreamUsage(providerId, credentialId, snapshot, now = Date.now()) {
    if (!providerId || !credentialId || !snapshot) return null
    const entry = {
      providerId,
      credentialId,
      group: toText(snapshot.group),
      username: toText(snapshot.username ?? snapshot.name ?? snapshot.display_name),
      quota: toNumber(snapshot.quota ?? snapshot.remain_quota ?? snapshot.remaining_quota),
      usedQuota: toNumber(snapshot.used_quota ?? snapshot.usedQuota),
      requestCount: toNumber(snapshot.request_count ?? snapshot.requestCount),
      status: toText(snapshot.status),
      updatedAt: now,
    }
    this.state.upstreamUsage[credentialId] = entry
    this.persist()
    return entry
  }

  clearUsage() {
    this.state.usage = createUsageState()
    this.persist()
    return this.getPublic()
  }

  clearRequestLog() {
    this.state.requestLog = []
    this.persist()
    return this.getPublic()
  }

  pruneProviders(providerIds) {
    const keep = new Set(providerIds)
    let changed = false

    for (const providerId of Object.keys(this.state.providerState)) {
      if (!keep.has(providerId)) {
        delete this.state.providerState[providerId]
        changed = true
      }
    }

    if (this.state.routing?.startProviderId && !keep.has(this.state.routing.startProviderId)) {
      this.state.routing = {
        ...normalizeRouting(this.state.routing),
        startProviderId: '',
        updatedAt: new Date().toISOString(),
      }
      changed = true
    }

    if (changed) this.persist()
    return this.getPublic()
  }

  resetProvider(providerId) {
    this.state.providerState[providerId] = createProviderState(providerId)
    this.persist()
    return this.state.providerState[providerId]
  }

  load() {
    try {
      return normalizeState(readJsonFile(this.filePath, EMPTY_STATE))
    } catch (error) {
      backupCorruptFile(this.filePath, error instanceof Error ? error.message : String(error))
      return normalizeState(EMPTY_STATE)
    }
  }

  ensureProvider(providerId) {
    if (!this.state.providerState[providerId]) {
      this.state.providerState[providerId] = createProviderState(providerId)
    }
    return this.state.providerState[providerId]
  }

  persist() {
    writeJsonFile(this.filePath, this.state)
  }
}

function normalizeState(value) {
  const requestLog = Array.isArray(value?.requestLog) ? value.requestLog.slice(0, DEFAULT_REQUEST_LOG_LIMIT) : []
  const rawUsage = value?.usage || { totals: emptyUsageBucket() }
  const state = {
    version: 1,
    providerState: {},
    routing: normalizeRouting(value?.routing),
    requestLog,
    usage: createUsageState(rawUsage),
    upstreamUsage: normalizeUpstreamUsage(value?.upstreamUsage),
    startedAt: typeof value?.startedAt === 'string' ? value.startedAt : null,
  }
  if (Number(rawUsage?.schemaVersion || 0) < USAGE_SCHEMA_VERSION) {
    backfillUsageDimensions(state.usage, requestLog)
  }

  if (value && typeof value.providerState === 'object' && !Array.isArray(value.providerState)) {
    for (const [providerId, entry] of Object.entries(value.providerState)) {
      state.providerState[providerId] = {
        ...createProviderState(providerId),
        ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}),
        providerId,
      }
    }
  }

  return state
}

function backfillUsageDimensions(usageState, requestLog) {
  let earliest = Number.POSITIVE_INFINITY
  for (const log of requestLog) {
    const timestamp = Date.parse(log?.time || '')
    if (!log?.usage || !Number.isFinite(timestamp)) continue
    earliest = Math.min(earliest, timestamp)
    const hourKey = hourKeyFor(timestamp)
    const dateKey = localDateKeyFor(timestamp)
    const modelKey = toText(log.routedModel || log.model) || '(unknown)'
    const finalAttempt = [...(Array.isArray(log.attempts) ? log.attempts : [])]
      .reverse()
      .find((attempt) => attempt?.providerId || attempt?.providerName)
    const providerKey = toText(log.providerId || finalAttempt?.providerId || log.providerName || finalAttempt?.providerName) || '(unknown)'

    usageState.modelHourly[modelKey] = addHourlyDimension(
      usageState.modelHourly[modelKey],
      hourKey,
      log.usage,
    )
    usageState.dailyByModel[modelKey] = addDailyDimension(
      usageState.dailyByModel[modelKey],
      dateKey,
      log.usage,
    )
    usageState.dailyByProvider[providerKey] = addDailyWindowDimension(
      usageState.dailyByProvider[providerKey],
      dateKey,
      log.usage,
      log.durationMs,
    )
  }
  if (Number.isFinite(earliest)) usageState.dimensionStartAt = earliest
}

function addHourlyDimension(hourly, hourKey, usage, latencyMs) {
  const next = hourly && typeof hourly === 'object' && !Array.isArray(hourly) ? hourly : {}
  next[hourKey] = addWindowUsage(next[hourKey], usage, latencyMs)
  return pruneHourly(next)
}

function addDailyDimension(daily, dateKey, usage) {
  const next = daily && typeof daily === 'object' && !Array.isArray(daily) ? daily : {}
  next[dateKey] = addUsage(next[dateKey], usage)
  return pruneDailyUsage(next, 366)
}

function addDailyWindowDimension(daily, dateKey, usage, latencyMs) {
  const next = daily && typeof daily === 'object' && !Array.isArray(daily) ? daily : {}
  next[dateKey] = addWindowUsage(next[dateKey], usage, latencyMs)
  return pruneDailyUsage(next, 366)
}

function localDateKeyFor(now) {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function normalizeRouting(value) {
  const startProviderId = toText(value?.startProviderId)
  const updatedAt = typeof value?.updatedAt === 'string'
    ? value.updatedAt
    : Number.isFinite(Number(value?.updatedAt))
      ? new Date(Number(value.updatedAt)).toISOString()
      : null
  return {
    startProviderId,
    startMode: normalizeStartMode(value?.startMode),
    updatedAt,
  }
}

function normalizeStartMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ROUTING_START_MODES.has(mode) ? mode : 'auto'
}

function normalizeRequestLogLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_REQUEST_LOG_LIMIT
  return Math.min(3000, Math.max(200, Math.round(number)))
}

function normalizeUpstreamUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [credentialId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const normalized = {
      providerId: toText(entry.providerId),
      credentialId: toText(entry.credentialId) || credentialId,
      group: toText(entry.group),
      username: toText(entry.username),
      quota: toNumber(entry.quota),
      usedQuota: toNumber(entry.usedQuota ?? entry.used_quota),
      requestCount: toNumber(entry.requestCount ?? entry.request_count),
      status: toText(entry.status),
      updatedAt: toNumber(entry.updatedAt),
    }
    if (
      normalized.group ||
      normalized.username ||
      normalized.quota ||
      normalized.usedQuota ||
      normalized.requestCount ||
      normalized.status
    ) {
      out[credentialId] = normalized
    }
  }
  return out
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function createProviderState(providerId) {
  return {
    providerId,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    reconnectFailureCount: 0,
    lastReconnectFailureAt: null,
    cooldownUntil: 0,
    lastStatus: null,
    lastError: null,
    lastLatencyMs: null,
    averageLatencyMs: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    updatedAt: Date.now(),
  }
}

function clampPositiveInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}
