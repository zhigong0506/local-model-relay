import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, resolveActiveCredential, resolveActiveKey } from '../src/config-store.mjs'
import { buildCandidates } from '../src/proxy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(resolve(root, 'work', 'config-regression-'))
const configFile = resolve(workDir, 'config.json')

try {
  const store = new ConfigStore(configFile)
  assert.equal(store.updateService({ listenPort: 70000 }).service.listenPort, 65535)
  assert.equal(store.updateService({ listenPort: 30001 }).service.listenPort, 30001)
  const disabled = store.createProvider({
    name: 'Disabled credentials',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'legacy-secret-must-not-be-used',
    credentials: [{ label: 'disabled', apiKey: 'disabled-secret', enabled: false }],
    models: ['regression-model'],
  })
  const privateDisabled = store.get().providers.find((provider) => provider.id === disabled.id)
  const publicDisabled = store.getPublic().providers.find((provider) => provider.id === disabled.id)
  assert.equal(resolveActiveKey(privateDisabled), '')
  assert.equal(resolveActiveCredential(privateDisabled), null)
  assert.equal(publicDisabled.apiKeySet, false)
  assert.equal(publicDisabled.activeCredentialLabel, '')
  assert.equal(resolveActiveKey({
    apiKey: 'stale-secret',
    credentials: [{ id: 'disabled', apiKey: 'disabled-secret', enabled: false }],
  }), '')

  const enabled = store.createProvider({
    name: 'Enabled route target',
    baseUrl: 'http://127.0.0.1:2/v1',
    credentials: [{ label: 'enabled', apiKey: 'enabled-secret', enabled: true }],
    models: ['regression-model-2'],
  })
  const firstRoute = store.createRoute({
    virtualModel: 'regression-model',
    targets: [{ providerId: disabled.id, model: 'regression-model' }],
  })
  assert.deepEqual(
    buildCandidates(store.get(), store.get().routes[0], 'regression-model', {
      isCooling: () => false,
      getStartProviderId: () => '',
    }),
    [],
  )

  assert.throws(
    () => store.createRoute({
      virtualModel: firstRoute.virtualModel,
      targets: [{ providerId: enabled.id, model: 'regression-model-2' }],
    }),
    (error) => error?.status === 409 && error?.code === 'duplicate_route_model',
  )

  const secondRoute = store.createRoute({
    virtualModel: 'regression-model-2',
    targets: [{ providerId: enabled.id, model: 'regression-model-2' }],
  })
  assert.throws(
    () => store.updateRoute(secondRoute.id, { virtualModel: firstRoute.virtualModel }),
    (error) => error?.status === 409 && error?.code === 'duplicate_route_model',
  )

  const duplicateImport = store.get()
  duplicateImport.routes.push({ ...firstRoute, id: randomUUID() })
  assert.throws(
    () => store.importConfig(duplicateImport),
    (error) => error?.status === 409 && error?.code === 'duplicate_route_model',
  )
  assert.equal(store.get().routes.length, 2)

  console.log(JSON.stringify({
    ok: true,
    disabledCredentialIsUnavailable: true,
    disabledLineIsNotRoutable: true,
    duplicateRouteCreationRejected: true,
    duplicateRouteUpdateRejected: true,
    duplicateRouteImportRejected: true,
    listenPortUpperBoundApplied: true,
  }, null, 2))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
