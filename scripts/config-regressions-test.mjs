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
  assert.equal(migratedConfig.version, 4)
  assert.deepEqual(migratedConfig.providerGroups.map((group) => group.id), ['openai', 'deepseek'])
  assert.equal(migratedConfig.providers[0].groupId, 'openai')
  assert.equal(migratedConfig.providers[0].providerType, 'openai_compatible')
  assert.equal(migratedConfig.providers[0].credentials[0].kind, 'api_key')

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

  const firstOAuth = store.upsertCodexOAuthCredential('', {
    kind: 'oauth',
    accessToken: fakeJwt({ email: 'oauth@example.test', account_id: 'workspace-a' }),
    refreshToken: 'refresh-secret-a',
    idToken: fakeJwt({
      email: 'oauth@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-a',
        chatgpt_plan_type: 'plus',
      },
    }),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    lastRefreshAt: new Date().toISOString(),
    email: 'oauth@example.test',
    accountId: 'workspace-a',
    planType: 'plus',
  })
  const secondOAuth = store.upsertCodexOAuthCredential(firstOAuth.provider.id, {
    kind: 'oauth',
    accessToken: fakeJwt({ email: 'oauth2@example.test', account_id: 'workspace-b' }),
    refreshToken: 'refresh-secret-b',
    email: 'oauth2@example.test',
    accountId: 'workspace-b',
  })
  const updatedFirstOAuth = store.upsertCodexOAuthCredential(firstOAuth.provider.id, {
    kind: 'oauth',
    accessToken: fakeJwt({ email: 'oauth@example.test', account_id: 'workspace-a' }),
    refreshToken: 'refresh-secret-a-rotated',
    email: 'oauth@example.test',
    accountId: 'workspace-a',
  })
  assert.equal(updatedFirstOAuth.credential.id, firstOAuth.credential.id)
  const oauthProvider = store.get().providers.find((provider) => provider.id === firstOAuth.provider.id)
  assert.equal(oauthProvider.providerType, 'codex_oauth')
  assert.equal(oauthProvider.baseUrl, 'https://chatgpt.com/backend-api/codex')
  assert.equal(oauthProvider.credentials.length, 2)
  assert.equal(oauthProvider.credentials.find((item) => item.id === firstOAuth.credential.id).refreshToken, 'refresh-secret-a-rotated')
  assert.throws(
    () => store.updateProvider(oauthProvider.id, { baseUrl: 'https://example.invalid/codex' }),
    (error) => error?.status === 400 && error?.code === 'invalid_provider',
  )
  assert.throws(
    () => store.updateProvider(oauthProvider.id, { providerType: 'openai_compatible' }),
    (error) => error?.status === 400 && error?.code === 'invalid_provider',
  )
  const publicOAuth = store.getPublic().providers.find((provider) => provider.id === firstOAuth.provider.id)
  assert.equal(publicOAuth.credentials[0].accessToken, undefined)
  assert.equal(publicOAuth.credentials[0].refreshToken, undefined)
  assert.equal(publicOAuth.credentials.every((credential) => credential.accessTokenSet), true)
  const redactedExport = JSON.stringify(store.exportConfig(false))
  assert.equal(redactedExport.includes('refresh-secret-a-rotated'), false)
  assert.equal(redactedExport.includes('refresh-secret-b'), false)
  const oauthCandidates = buildCandidates(store.get(), null, 'oauth-model', {
    isCooling: () => false,
    getStartProviderId: () => firstOAuth.provider.id,
  }).filter((candidate) => candidate.provider.id === firstOAuth.provider.id)
  assert.equal(oauthCandidates.length, 2)
  assert.deepEqual(oauthCandidates.map((candidate) => candidate.credential.id), [firstOAuth.credential.id, secondOAuth.credential.id])

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
    oauthCredentialsMigratedAndRedacted: true,
    oauthWorkspaceDedupeApplied: true,
    oauthAccountCandidatesExpanded: true,
  }, null, 2))
} finally {
  await rm(workDir, { recursive: true, force: true })
}

function fakeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}
