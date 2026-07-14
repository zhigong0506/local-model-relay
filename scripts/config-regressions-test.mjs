import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, resolveActiveCredential, resolveActiveKey } from '../src/config-store.mjs'
import { buildCandidates } from '../src/proxy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = await mkdtemp(resolve(root, 'work', 'config-regression-'))
const configFile = resolve(workDir, 'config.json')
const legacyConfigFile = resolve(workDir, 'legacy-config.json')

try {
  await writeFile(legacyConfigFile, JSON.stringify({
    version: 2,
    service: {},
    providers: [{
      id: 'legacy-provider',
      name: 'Legacy provider',
      baseUrl: 'http://127.0.0.1:3/v1',
      apiKey: 'legacy-test-secret',
      models: ['legacy-model'],
    }],
    routes: [],
  }), 'utf8')
  const legacyStore = new ConfigStore(legacyConfigFile)
  const migratedConfig = legacyStore.get()
  assert.equal(migratedConfig.version, 3)
  assert.deepEqual(migratedConfig.providerGroups.map((group) => group.id), ['openai', 'deepseek'])
  assert.equal(migratedConfig.providers[0].groupId, 'openai')

  const store = new ConfigStore(configFile)
  assert.deepEqual(store.get().providerGroups.map((group) => group.id), ['openai', 'deepseek'])
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

  const customGroup = store.createProviderGroup({
    name: 'DeepSeek 海外',
    description: '分组回归测试',
    color: '#1677aa',
  })
  assert.throws(
    () => store.createProviderGroup({ name: 'deepseek 海外' }),
    (error) => error?.status === 409 && error?.code === 'duplicate_provider_group',
  )
  assert.throws(
    () => store.createProvider({
      name: 'Invalid group target',
      baseUrl: 'http://127.0.0.1:4/v1',
      groupId: 'missing-group',
      models: ['group-model'],
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_provider_group',
  )
  const groupedProvider = store.createProvider({
    name: 'Grouped provider',
    baseUrl: 'http://127.0.0.1:5/v1',
    groupId: customGroup.id,
    models: ['group-model'],
  })
  assert.equal(groupedProvider.groupId, customGroup.id)
  assert.throws(
    () => store.deleteProviderGroup(customGroup.id),
    (error) => error?.status === 409 && error?.code === 'provider_group_not_empty',
  )
  const movedProvider = store.updateProvider(groupedProvider.id, { groupId: 'deepseek' })
  assert.equal(movedProvider.groupId, 'deepseek')
  const afterGroupDelete = store.deleteProviderGroup(customGroup.id)
  assert.equal(afterGroupDelete.providerGroups.some((group) => group.id === customGroup.id), false)

  console.log(JSON.stringify({
    ok: true,
    legacyProvidersMigratedToOpenAi: true,
    defaultProviderGroupsCreated: true,
    duplicateProviderGroupRejected: true,
    missingProviderGroupRejected: true,
    nonEmptyProviderGroupProtected: true,
    providerCanMoveBetweenGroups: true,
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
