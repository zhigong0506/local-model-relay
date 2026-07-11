import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const stamp = Date.now()
const model = `quota-exhaustion-long-task-${stamp}`
const successfulRoundsBeforeQuota = 3
const createdProviders = []
let createdRouteId = ''
let primaryHits = 0
let fallbackHits = 0

const primaryServer = await startPrimaryUpstream()
const fallbackServer = await startFallbackUpstream()

try {
  const config = await api('/api/config')
  const localKey = config.service.localApiKey
  const primary = await createProvider('TMP long task primary', serverBaseUrl(primaryServer), 9400, 120)
  const fallback = await createProvider('TMP long task fallback', serverBaseUrl(fallbackServer), 9410, 2)
  createdProviders.push(primary, fallback)

  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: createdProviders.map((provider) => ({
        providerId: provider.id,
        model,
        priority: provider.priority,
      })),
      notes: 'temporary long task quota exhaustion regression route',
      enabled: true,
    },
  })
  createdRouteId = route.id

  const rounds = []
  for (let index = 1; index <= successfulRoundsBeforeQuota + 2; index += 1) {
    rounds.push(await relayStream(localKey, index))
  }

  const state = await api('/api/state')
  const logs = (state.requestLog || []).filter((entry) => entry.model === model)
  const quotaLog = logs.find((entry) =>
    (entry.attempts || []).length === 2 &&
    entry.attempts[0]?.providerId === primary.id &&
    entry.attempts[0]?.status === 402 &&
    entry.attempts[1]?.providerId === fallback.id &&
    entry.attempts[1]?.status === 200,
  )
  const fallbackOnlyLog = logs.find((entry) =>
    entry.providerId === fallback.id &&
    (entry.attempts || []).length === 1 &&
    entry.attempts[0]?.providerId === fallback.id,
  )
  const primaryState = state.providerState?.[primary.id]

  const normalRoundsOk = rounds.slice(0, successfulRoundsBeforeQuota).every((round, index) =>
    round.status === 200 &&
    round.provider === primary.name &&
    round.attempts === '1' &&
    round.text === `PRIMARY_ROUND_${index + 1}`,
  )
  const quotaRound = rounds[successfulRoundsBeforeQuota]
  const followupRound = rounds[successfulRoundsBeforeQuota + 1]
  const report = {
    ok: normalRoundsOk &&
      quotaRound?.status === 200 &&
      quotaRound?.provider === fallback.name &&
      quotaRound?.attempts === '2' &&
      quotaRound?.text === 'BACKUP_AFTER_QUOTA' &&
      followupRound?.status === 200 &&
      followupRound?.provider === fallback.name &&
      followupRound?.attempts === '1' &&
      followupRound?.text === 'BACKUP_STEADY' &&
      primaryHits === successfulRoundsBeforeQuota + 1 &&
      fallbackHits === 2 &&
      Boolean(quotaLog) &&
      Boolean(fallbackOnlyLog) &&
      Number(primaryState?.cooldownUntil || 0) > Date.now() &&
      primaryState?.lastStatus === 402,
    model,
    normalRounds: rounds.slice(0, successfulRoundsBeforeQuota),
    quotaRound,
    followupRound,
    primaryHits,
    fallbackHits,
    quotaAttemptStatuses: (quotaLog?.attempts || []).map((attempt) => ({
      provider: attempt.providerName,
      status: attempt.status,
    })),
    primaryCooldownActive: Number(primaryState?.cooldownUntil || 0) > Date.now(),
    primaryLastStatus: primaryState?.lastStatus || null,
  }

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await cleanup()
}

async function createProvider(name, baseUrl, priority, cooldownSeconds) {
  return api('/api/providers', {
    method: 'POST',
    body: {
      name,
      baseUrl,
      credentials: [{ label: 'mock', apiKey: 'mock-key', enabled: true }],
      authMode: 'authorization',
      wireApi: 'chat',
      priority,
      timeoutMs: 5000,
      cooldownSeconds,
      models: [model],
      tags: ['tmp-quota-exhaustion-test'],
      notes: 'temporary long task quota exhaustion provider',
      enabled: true,
    },
  })
}

async function startPrimaryUpstream() {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    primaryHits += 1
    if (primaryHits > successfulRoundsBeforeQuota) {
      res.writeHead(402, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        error: {
          type: 'insufficient_quota',
          message: 'Simulated upstream quota exhausted during a long task.',
        },
      }))
      return
    }
    writeChatTextStream(res, `PRIMARY_ROUND_${primaryHits}`)
  })
  return listen(server)
}

async function startFallbackUpstream() {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    fallbackHits += 1
    writeChatTextStream(res, fallbackHits === 1 ? 'BACKUP_AFTER_QUOTA' : 'BACKUP_STEADY')
  })
  return listen(server)
}

function writeChatTextStream(res, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
  const midpoint = Math.ceil(text.length / 2)
  for (const delta of [text.slice(0, midpoint), text.slice(midpoint)]) {
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${stamp}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({
    id: `chatcmpl-${stamp}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  })}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function relayStream(localKey, round) {
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      input: `long task turn ${round}`,
      max_output_tokens: 32,
    }),
  })
  const raw = await response.text()
  const events = parseSse(raw)
  return {
    status: response.status,
    provider: decodeURIComponent(response.headers.get('x-local-relay-provider') || ''),
    attempts: response.headers.get('x-local-relay-attempts'),
    text: events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta || '')
      .join(''),
  }
}

function parseSse(raw) {
  const events = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  return events
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function serverBaseUrl(server) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
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
  await Promise.all([primaryServer, fallbackServer].map((server) =>
    new Promise((resolve) => server.close(resolve)),
  ))
}
