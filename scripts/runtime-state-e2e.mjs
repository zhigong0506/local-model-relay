import assert from 'node:assert/strict'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'

const full = await api('/api/state')
const summary = await api('/api/state/summary')

assert.equal(full.runtimeMeta?.protocolVersion, 1)
assert.equal(summary.runtimeMeta?.protocolVersion, 1)
assert.equal(summary.runtimeMeta?.restartRequired, false)
assert.equal(typeof summary.runtimeMeta?.serverStartedAt, 'string')
assert.equal(typeof summary.runtimeMeta?.backendSourceUpdatedAt, 'string')
assert.equal(Object.hasOwn(summary, 'requestLog'), false)
assert.equal(Object.hasOwn(summary, 'sessionBindings'), false)
assert.equal(summary.requestLogCount, full.requestLog.length)
assert.equal(summary.sessionBindingCount, Object.keys(full.sessionBindings || {}).length)

const routingBefore = structuredClone(full.routing)
const invalid = await rawApi('/api/routing/start', {
  method: 'POST',
  body: { providerId: '', mode: 'not-a-mode' },
})
assert.equal(invalid.response.status, 400)
assert.equal(invalid.data.error?.type, 'invalid_routing_mode')
assert.deepEqual((await api('/api/state/summary')).routing, routingBefore)

const fullBytes = Buffer.byteLength(JSON.stringify(full))
const summaryBytes = Buffer.byteLength(JSON.stringify(summary))
assert.ok(summaryBytes <= fullBytes + 512, 'An empty summary should stay close to the empty full-state payload size.')

console.log(JSON.stringify({
  ok: true,
  protocolVersion: summary.runtimeMeta.protocolVersion,
  restartRequired: summary.runtimeMeta.restartRequired,
  requestLogCount: summary.requestLogCount,
  sessionBindingCount: summary.sessionBindingCount,
  fullBytes,
  summaryBytes,
  reductionPercent: Math.round((1 - summaryBytes / fullBytes) * 1000) / 10,
}, null, 2))

async function api(path, options = {}) {
  const { response, data } = await rawApi(path, options)
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)
  return data
}

async function rawApi(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${relay}${path}`, init)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}
