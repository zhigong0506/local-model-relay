import assert from 'node:assert/strict'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'

const initial = await api('/api/config')
assert.equal(initial.version, 3)
assert.deepEqual(initial.providerGroups.map((group) => group.id), ['openai', 'deepseek'])

const createdGroup = await api('/api/provider-groups', {
  method: 'POST',
  body: {
    id: 'openai',
    name: 'Claude',
    description: 'API contract test group',
    color: '#c06bd8',
  },
})
assert.equal(createdGroup.name, 'Claude')
assert.equal(createdGroup.color, '#c06bd8')
assert.notEqual(createdGroup.id, 'openai')

const duplicate = await rawApi('/api/provider-groups', {
  method: 'POST',
  body: { name: 'claude' },
})
assert.equal(duplicate.response.status, 409)
assert.equal(duplicate.data.error?.type, 'duplicate_provider_group')

const updatedGroup = await api(`/api/provider-groups/${createdGroup.id}`, {
  method: 'PATCH',
  body: {
    name: 'Claude 海外',
    description: 'Updated group description',
    color: '#8c68d8',
  },
})
assert.equal(updatedGroup.name, 'Claude 海外')
assert.equal(updatedGroup.color, '#8c68d8')

const groupedProvider = await api('/api/providers', {
  method: 'POST',
  body: {
    name: 'Grouped E2E provider',
    groupId: createdGroup.id,
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'provider-groups-e2e-secret',
    models: ['provider-groups-model'],
  },
})
assert.equal(groupedProvider.groupId, createdGroup.id)
assert.equal(Object.hasOwn(groupedProvider, 'apiKey'), false)

const nonEmptyDelete = await rawApi(`/api/provider-groups/${createdGroup.id}`, { method: 'DELETE' })
assert.equal(nonEmptyDelete.response.status, 409)
assert.equal(nonEmptyDelete.data.error?.type, 'provider_group_not_empty')

const invalidProvider = await rawApi('/api/providers', {
  method: 'POST',
  body: {
    name: 'Missing group provider',
    groupId: 'missing-provider-group',
    baseUrl: 'http://127.0.0.1:2/v1',
    models: ['provider-groups-model'],
  },
})
assert.equal(invalidProvider.response.status, 400)
assert.equal(invalidProvider.data.error?.type, 'invalid_provider_group')

const movedProvider = await api(`/api/providers/${groupedProvider.id}`, {
  method: 'PATCH',
  body: { groupId: 'deepseek' },
})
assert.equal(movedProvider.groupId, 'deepseek')

const afterDelete = await api(`/api/provider-groups/${createdGroup.id}`, { method: 'DELETE' })
assert.equal(afterDelete.providerGroups.some((group) => group.id === createdGroup.id), false)
assert.equal(afterDelete.providers.find((provider) => provider.id === groupedProvider.id)?.groupId, 'deepseek')

const defaultProvider = await api('/api/providers', {
  method: 'POST',
  body: {
    name: 'Default group provider',
    baseUrl: 'http://127.0.0.1:3/v1',
    models: ['provider-groups-default-model'],
  },
})
assert.equal(defaultProvider.groupId, 'openai')

console.log(JSON.stringify({
  ok: true,
  defaultGroups: initial.providerGroups.map((group) => group.name),
  groupCrud: true,
  duplicateNameRejected: true,
  clientSuppliedGroupIdIgnored: true,
  nonEmptyDeleteRejected: true,
  providerMovePersisted: true,
  defaultProviderGroup: defaultProvider.groupId,
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
