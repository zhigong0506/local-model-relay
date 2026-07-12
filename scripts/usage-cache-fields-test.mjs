import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StateStore } from '../src/state-store.mjs'
import { normalizeUsagePayload } from '../src/wire-api.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = resolve(root, 'work')
const stateFile = resolve(workDir, `usage-cache-fields-${process.pid}-${randomUUID()}.json`)

mkdirSync(workDir, { recursive: true })

try {
  const nested = normalizeUsagePayload({
    input: { totalTokens: 100 },
    output: { totalTokens: 20 },
    cache: { readTokens: 40, writeTokens: 5 },
    totalTokens: 120,
  })
  assert.deepEqual(nested, {
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 40,
    cachedTokensReported: true,
    cacheWriteTokens: 5,
    totalTokens: 120,
  })

  const explicitZero = normalizeUsagePayload({
    input_tokens: 80,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    total_tokens: 90,
  })
  assert.equal(explicitZero.cachedTokens, 0)
  assert.equal(explicitZero.cachedTokensReported, true)

  // Construct timestamps in the runtime's local timezone because production
  // daily dimensions intentionally use local calendar dates.
  const oldTimestamp = new Date(2026, 6, 10, 12, 30).getTime()
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    requestLog: [{
      id: 'old-log',
      time: new Date(oldTimestamp).toISOString(),
      model: 'virtual-test',
      routedModel: 'upstream-test',
      providerName: '历史线路',
      durationMs: 250,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        totalTokens: 120,
      },
    }],
    usage: {
      totals: {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        totalTokens: 120,
        requests: 1,
      },
    },
  }, null, 2), 'utf8')

  const store = new StateStore(stateFile)
  let state = store.getPublic()
  assert.equal(state.usage.schemaVersion, 2)
  assert.equal(state.usage.dimensionStartAt, oldTimestamp)
  assert.equal(state.usage.modelHourly['upstream-test'][String(Math.floor(oldTimestamp / 3600000))].totalTokens, 120)
  assert.equal(state.usage.providerHourly['历史线路'][String(Math.floor(oldTimestamp / 3600000))].latencySum, 250)
  assert.equal(state.usage.dailyByModel['upstream-test']['2026-07-10'].cachedTokens, 40)
  assert.equal(state.usage.dailyByProvider['历史线路']['2026-07-10'].latencySum, 250)

  const nextTimestamp = new Date(2026, 6, 10, 13, 15).getTime()
  store.recordUsage('provider-id', 'upstream-test', {
    inputTokens: 80,
    outputTokens: 10,
    cachedTokens: 32,
    cachedTokensReported: true,
    totalTokens: 90,
  }, { latencyMs: 300 }, nextTimestamp)
  state = store.getPublic()

  assert.equal(state.usage.modelHourly['upstream-test'][String(Math.floor(nextTimestamp / 3600000))].cachedTokens, 32)
  assert.equal(state.usage.dailyByProvider['provider-id']['2026-07-10'].latencySum, 300)
  assert.equal(state.usage.dailyByModel['upstream-test']['2026-07-10'].totalTokens, 210)
  assert.equal(state.usage.totals.cacheReportedRequests, 1)

  console.log(JSON.stringify({
    ok: true,
    aliases: 'nested cache fields parsed',
    migration: 'hourly and daily dimensions rebuilt',
    cacheHitRate: 'cachedTokens / inputTokens',
  }, null, 2))
} finally {
  if (existsSync(stateFile)) rmSync(stateFile)
}
