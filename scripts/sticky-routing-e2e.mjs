import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `sticky-e2e-${stamp}`
const hits = []
const createdProviders = []
let createdRouteId = ''
let originalRouting = { startProviderId: '', startMode: 'auto' }

const scenarios = [
  { name: 'Sticky 01 OK', status: 200, message: 'STICKY_ONE' },
  { name: 'Sticky 02 OK', status: 200, message: 'STICKY_TWO' },
  { name: 'Sticky 03 FAIL', status: 502, message: 'sticky third failed' },
  { name: 'Sticky 04 OK', status: 200, message: 'STICKY_FOUR' },
]

const servers = await Promise.all(scenarios.map(startMockUpstream))

try {
  const config = await api('/api/config')
  const localKey = config.service.localApiKey
  originalRouting = (await api('/api/state')).routing || originalRouting

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index]
    const provider = await api('/api/providers', {
      method: 'POST',
      body: {
        name: `TMP ${scenario.name}`,
        baseUrl: serverBaseUrl(servers[index]),
        credentials: [{ label: 'mock', apiKey: `mock-key-${index + 1}`, enabled: true }],
        authMode: 'authorization',
        wireApi: 'chat',
        priority: 9300 + index * 10,
        timeoutMs: 5000,
        cooldownSeconds: 0,
        models: [model],
        tags: ['tmp-sticky-routing-test'],
        notes: 'temporary sticky routing e2e test provider',
        enabled: true,
      },
    })
    createdProviders.push(provider)
  }

  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: createdProviders.map((provider) => ({ providerId: provider.id, model, priority: provider.priority })),
      notes: 'temporary sticky routing e2e test route',
      enabled: true,
    },
  })
  createdRouteId = route.id

  const locked = await lockedStartCheck(localKey)
  const auto = await autoAdvanceCheck(localKey)
  const disabled = await disabledStartCheck(localKey)
  const pruned = await pruneCheck()

  const report = {
    ok: locked.ok && auto.ok && disabled.ok && pruned.ok,
    model,
    locked,
    auto,
    disabled,
    pruned,
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
  await restoreRouting(originalRouting)
}

async function lockedStartCheck(localKey) {
  hits.length = 0
  await api('/api/routing/start', {
    method: 'POST',
    body: { providerId: createdProviders[2].id, mode: 'locked' },
  })

  const result = await relayChat(localKey)
  const routing = (await api('/api/state')).routing
  const expectedOrder = ['Sticky 03 FAIL', 'Sticky 04 OK']
  return {
    ok: result.status === 200 &&
      result.text === 'STICKY_FOUR' &&
      result.attemptsHeader === '2' &&
      hitNames().join('|') === expectedOrder.join('|') &&
      routing.startProviderId === createdProviders[2].id &&
      routing.startMode === 'locked',
    responseStatus: result.status,
    responseText: result.text,
    attemptsHeader: result.attemptsHeader,
    hitOrder: hitNames(),
    startProviderId: routing.startProviderId,
    startMode: routing.startMode,
  }
}

async function autoAdvanceCheck(localKey) {
  hits.length = 0
  await api('/api/routing/start', {
    method: 'POST',
    body: { providerId: createdProviders[2].id, mode: 'auto' },
  })

  const first = await relayChat(localKey)
  const routingAfterFirst = (await api('/api/state')).routing
  hits.length = 0
  const second = await relayChat(localKey)
  const routingAfterSecond = (await api('/api/state')).routing

  return {
    ok: first.status === 200 &&
      first.text === 'STICKY_FOUR' &&
      routingAfterFirst.startProviderId === createdProviders[3].id &&
      second.status === 200 &&
      second.text === 'STICKY_FOUR' &&
      second.attemptsHeader === '1' &&
      hitNames().join('|') === 'Sticky 04 OK' &&
      routingAfterSecond.startProviderId === createdProviders[3].id &&
      routingAfterSecond.startMode === 'auto',
    first: {
      status: first.status,
      text: first.text,
      attemptsHeader: first.attemptsHeader,
      advancedTo: routingAfterFirst.startProviderId,
    },
    second: {
      status: second.status,
      text: second.text,
      attemptsHeader: second.attemptsHeader,
      hitOrder: hitNames(),
      startProviderId: routingAfterSecond.startProviderId,
      startMode: routingAfterSecond.startMode,
    },
  }
}

async function disabledStartCheck(localKey) {
  await api(`/api/providers/${createdProviders[2].id}`, {
    method: 'PATCH',
    body: { enabled: false },
  })
  await api('/api/routing/start', {
    method: 'POST',
    body: { providerId: createdProviders[2].id, mode: 'locked' },
  })

  hits.length = 0
  const result = await relayChat(localKey)
  await api(`/api/providers/${createdProviders[2].id}`, {
    method: 'PATCH',
    body: { enabled: true },
  })

  return {
    ok: result.status === 200 &&
      result.text === 'STICKY_ONE' &&
      result.attemptsHeader === '1' &&
      hitNames().join('|') === 'Sticky 01 OK',
    responseStatus: result.status,
    responseText: result.text,
    attemptsHeader: result.attemptsHeader,
    hitOrder: hitNames(),
  }
}

async function pruneCheck() {
  await api('/api/routing/start', {
    method: 'POST',
    body: { providerId: createdProviders[2].id, mode: 'locked' },
  })
  await api(`/api/providers/${createdProviders[2].id}`, { method: 'DELETE' })
  const deleted = createdProviders.splice(2, 1)[0]
  const routing = (await api('/api/state')).routing
  return {
    ok: deleted.id && routing.startProviderId === '' && routing.startMode === 'locked',
    deletedProviderId: deleted.id,
    startProviderId: routing.startProviderId,
    startMode: routing.startMode,
  }
}

async function startMockUpstream(scenario, index) {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    hits.push({ index: index + 1, name: scenario.name, method: req.method, url: req.url, body: raw })
    res.statusCode = scenario.status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(mockBody(scenario)))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function mockBody(scenario) {
  if (scenario.status >= 400) return { error: { message: scenario.message } }
  return {
    id: `chatcmpl-${stamp}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: scenario.message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  }
}

function serverBaseUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function relayChat(localKey) {
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'test sticky routing' }],
      max_tokens: 8,
    }),
  })
  const body = await response.json()
  return {
    status: response.status,
    attemptsHeader: response.headers.get('x-local-relay-attempts'),
    providerHeader: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    text: body?.choices?.[0]?.message?.content || '',
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${relay}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${text}`)
  return body
}

async function restoreRouting(routing) {
  const providerId = String(routing?.startProviderId || '')
  const mode = routing?.startMode === 'locked' ? 'locked' : 'auto'
  if (!providerId) {
    await api('/api/routing/start', { method: 'POST', body: { providerId: '', mode } })
    return
  }

  try {
    await api('/api/routing/start', { method: 'POST', body: { providerId, mode } })
  } catch {
    await api('/api/routing/start', { method: 'DELETE' })
  }
}

async function cleanup() {
  if (createdRouteId) {
    try {
      await api(`/api/routes/${createdRouteId}`, { method: 'DELETE' })
    } catch {}
  }

  for (const provider of createdProviders.reverse()) {
    try {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    } catch {}
  }

  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
}

function hitNames() {
  return hits.map((hit) => hit.name)
}
