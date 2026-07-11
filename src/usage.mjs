const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'totalTokens',
]

const USAGE_COUNTER_KEYS = [
  'cacheReportedRequests',
  'cacheUnreportedRequests',
  'estimatedRequests',
]

export const USAGE_SCHEMA_VERSION = 2

export function emptyUsageBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requests: 0,
    cacheReportedRequests: 0,
    cacheUnreportedRequests: 0,
    estimatedRequests: 0,
  }
}

export function normalizeUsage(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const reportedCacheValue =
    value.input_tokens_details?.cached_tokens ??
    value.prompt_tokens_details?.cached_tokens ??
    value.cache_read_input_tokens ??
    value.cache_read_tokens ??
    value.cacheRead ??
    value.readCache ??
    value.cache?.readTokens ??
    value.cache?.read_tokens ??
    value.cache?.cachedTokens
  const cachedTokenValue =
    value.cachedTokens ??
    reportedCacheValue
  const inputTokens = tokenCount(value.inputTokens ?? value.prompt_tokens ?? value.input_tokens ?? value.input)
  const outputTokens = tokenCount(value.outputTokens ?? value.completion_tokens ?? value.output_tokens ?? value.output)
  const cachedTokens = tokenCount(cachedTokenValue)
  const cacheWriteTokens = tokenCount(
    value.cacheWriteTokens ??
    value.cache_creation_input_tokens ??
    value.cache_write_input_tokens ??
    value.cache_write_tokens ??
    value.cacheWrite ??
    value.writeCache ??
    value.cache?.writeTokens ??
    value.cache?.write_tokens ??
    value.cache?.creationTokens,
  )
  const totalTokens = tokenCount(value.totalTokens ?? value.total_tokens ?? value.total) || inputTokens + outputTokens
  const cachedTokensReported = typeof value.cachedTokensReported === 'boolean'
    ? value.cachedTokensReported
    : reportedCacheValue !== undefined && reportedCacheValue !== null
      ? true
      : undefined

  if (!inputTokens && !outputTokens && !cachedTokens && !cacheWriteTokens && !totalTokens) return null

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    cachedTokensReported,
    cacheWriteTokens,
    totalTokens,
    estimated: value.estimated === true,
  }
}

export function addUsage(target, usage, requestCount = 1) {
  const bucket = normalizeUsageBucket(target)
  const normalized = normalizeUsage(usage)
  if (!normalized) return bucket

  for (const key of USAGE_KEYS) {
    bucket[key] += normalized[key]
  }
  bucket.requests += requestCount
  if (normalized.cachedTokensReported === true) bucket.cacheReportedRequests += requestCount
  if (normalized.cachedTokensReported === false) bucket.cacheUnreportedRequests += requestCount
  if (normalized.estimated) bucket.estimatedRequests += requestCount
  return bucket
}

export function emptyWindowBucket() {
  return { ...emptyUsageBucket(), latencySum: 0, latencyCount: 0 }
}

export function addWindowUsage(target, usage, latencyMs, requestCount = 1) {
  const bucket = normalizeWindowBucket(target)
  const normalized = normalizeUsage(usage)
  if (normalized) {
    for (const key of USAGE_KEYS) {
      bucket[key] += normalized[key]
    }
    if (normalized.cachedTokensReported === true) bucket.cacheReportedRequests += requestCount
    if (normalized.cachedTokensReported === false) bucket.cacheUnreportedRequests += requestCount
    if (normalized.estimated) bucket.estimatedRequests += requestCount
  }
  bucket.requests += requestCount
  if (Number.isFinite(latencyMs) && latencyMs > 0) {
    bucket.latencySum += Math.round(latencyMs)
    bucket.latencyCount += 1
  }
  return bucket
}

export function normalizeWindowBucket(value) {
  const bucket = normalizeUsageBucket(value)
  bucket.latencySum = numberOrZero(value?.latencySum)
  bucket.latencyCount = numberOrZero(value?.latencyCount)
  return bucket
}

// 小时桶键 = epoch 小时（Math.floor(now / 3600000)），窗口过滤只需数值比较，天然时区无关。
export function hourKeyFor(now = Date.now()) {
  return String(Math.floor(now / 3600000))
}

export function pruneHourly(hourly, keepHours = 745) {
  if (!hourly || typeof hourly !== 'object') return {}
  const entries = Object.entries(hourly).sort(([a], [b]) => Number(b) - Number(a))
  return Object.fromEntries(entries.slice(0, keepHours))
}

export function normalizeUsageBucket(value) {
  const bucket = emptyUsageBucket()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bucket

  for (const key of USAGE_KEYS) {
    bucket[key] = numberOrZero(value[key])
  }
  bucket.requests = numberOrZero(value.requests)
  for (const key of USAGE_COUNTER_KEYS) {
    bucket[key] = numberOrZero(value[key])
  }
  return bucket
}

export function createUsageState(value = {}) {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    dimensionStartAt: finiteTimestamp(value.dimensionStartAt),
    totals: normalizeUsageBucket(value.totals),
    byProvider: normalizeUsageMap(value.byProvider),
    byCredential: normalizeUsageMap(value.byCredential),
    byModel: normalizeUsageMap(value.byModel),
    daily: normalizeUsageMap(value.daily),
    providerHourly: normalizeProviderHourly(value.providerHourly),
    modelHourly: normalizeProviderHourly(value.modelHourly),
    dailyByProvider: normalizeDimensionDaily(value.dailyByProvider, true),
    dailyByModel: normalizeDimensionDaily(value.dailyByModel),
  }
}

export function pruneDailyUsage(daily, keepDays = 90) {
  const entries = Object.entries(daily).sort(([a], [b]) => b.localeCompare(a))
  return Object.fromEntries(entries.slice(0, keepDays))
}

function normalizeUsageMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).map(([key, bucket]) => [key, normalizeUsageBucket(bucket)]),
  )
}

function normalizeProviderHourly(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [providerId, hourly] of Object.entries(value)) {
    if (!hourly || typeof hourly !== 'object' || Array.isArray(hourly)) continue
    out[providerId] = pruneHourly(
      Object.fromEntries(
        Object.entries(hourly).map(([hourKey, bucket]) => [hourKey, normalizeWindowBucket(bucket)]),
      ),
    )
  }
  return out
}

function normalizeDimensionDaily(value, withWindow = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [dimension, daily] of Object.entries(value)) {
    if (!daily || typeof daily !== 'object' || Array.isArray(daily)) continue
    out[dimension] = pruneDailyUsage(
      Object.fromEntries(
        Object.entries(daily).map(([dateKey, bucket]) => [
          dateKey,
          withWindow ? normalizeWindowBucket(bucket) : normalizeUsageBucket(bucket),
        ]),
      ),
      366,
    )
  }
  return out
}

function tokenCount(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return numberOrZero(
      value.totalTokens ??
      value.total_tokens ??
      value.tokens ??
      value.value,
    )
  }
  return numberOrZero(value)
}

function finiteTimestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}
