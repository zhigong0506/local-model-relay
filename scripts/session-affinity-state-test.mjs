import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state-store.mjs'

const root = await mkdtemp(join(tmpdir(), 'local-model-relay-session-state-'))
const statePath = join(root, 'state.json')
const migrationPath = join(root, 'migration-state.json')
const now = 1_800_000_000_000

try {
  const store = new StateStore(statePath)
  for (let index = 0; index < 50; index += 1) {
    store.setSessionBinding('client', `session-${index}`, { providerId: `provider-${index}`, model: 'model-a' }, { ttlSeconds: 300, limit: 50 }, now + index)
  }
  store.setSessionBinding('response', 'resp-over-limit', { providerId: 'provider-over-limit', model: 'model-b' }, { ttlSeconds: 300, limit: 50 }, now + 51)

  assert.equal(store.getSessionBinding('client', 'session-0', now + 52), null)
  assert.equal(store.getSessionBinding('client', 'session-49', now + 52)?.providerId, 'provider-49')
  assert.equal(store.getSessionBinding('response', 'resp-over-limit', now + 52)?.providerId, 'provider-over-limit')
  assert.equal(Object.keys(store.getPublic().sessionBindings).length, 50)

  store.setSessionBinding('client', 'expired-session', { providerId: 'expired-provider' }, { ttlSeconds: 300, limit: 50 }, now + 53)
  assert.equal(store.getSessionBinding('client', 'expired-session', now + 300_054), null)

  const persisted = await readFile(statePath, 'utf8')
  assert.doesNotMatch(persisted, /session-0|session-49|resp-over-limit|expired-session/)
  assert.equal(Object.keys(JSON.parse(persisted).sessionBindings || {}).every((key) => /^[a-f0-9]{64}$/i.test(key)), true)

  await writeFile(migrationPath, JSON.stringify({
    version: 1,
    providerState: {},
    routing: { startProviderId: '', startMode: 'auto' },
    requestLog: [],
    usage: {},
    upstreamUsage: {},
  }), 'utf8')
  const migrated = new StateStore(migrationPath)
  assert.equal(migrated.getPublic().version, 2)
  assert.deepEqual(migrated.getPublic().sessionBindings, {})

  console.log(JSON.stringify({
    ok: true,
    ttlExpiry: true,
    capacityPruning: true,
    hashedPersistence: true,
    oldStateMigration: true,
  }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
