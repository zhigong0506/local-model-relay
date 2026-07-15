import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const model = `oauth-account-failover-${Date.now()}`
const hits = []
let providerId = ''
let routeId = ''
let upstream = null

try {
  upstream = await startUpstream()
  const provider = await api('/api/providers', {
    method: 'POST',
    body: {
      name: 'TMP Codex OAuth failover',
      providerType: 'codex_oauth',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      credentials: [
        {
          id: 'oauth-account-first',
          label: 'First OAuth account',
          kind: 'access_token',
          providerType: 'codex',
          accessToken: 'oauth-access-token-first',
          accountId: 'workspace-first',
          enabled: true,
        },
        {
          id: 'oauth-account-second',
          label: 'Second OAuth account',
          kind: 'access_token',
          providerType: 'codex',
          accessToken: 'oauth-access-token-second',
          accountId: 'workspace-second',
          enabled: true,
        },
      ],
      activeCredentialId: 'oauth-account-first',
      authMode: 'authorization',
      wireApi: 'responses',
      priority: 9900,
      timeoutMs: 5000,
      cooldownSeconds: 1,
      models: [model],
      enabled: true,
    },
  })
  providerId = provider.id

  const route = await api('/api/routes', {
    method: 'POST',
    body: {
      virtualModel: model,
      targets: [{ providerId, model, priority: 10 }],
      enabled: true,
    },
  })
  routeId = route.id

  const routeTest = await api(`/api/routes/${routeId}/real-test`, {
    method: 'POST',
    body: { maxTokens: 8 },
  })
  assertRouteCredentialFailover(routeTest)
  hits.length = 0

  const config = await api('/api/config')
  const response = await fetch(`${relay}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.service.localApiKey}`,
    },
    body: JSON.stringify({
      model,
      input: 'test oauth account failover',
      stream: false,
      max_output_tokens: 8,
    }),
  })
  const payload = await response.json()
  const after = await api('/api/config')
  const savedProvider = after.providers.find((item) => item.id === providerId)
  const firstCredential = savedProvider.credentials.find((item) => item.id === 'oauth-account-first')

  const report = {
    ok: response.status === 200 &&
      payload.output_text === 'OAUTH_FAILOVER_OK' &&
      response.headers.get('x-local-relay-attempts') === '2' &&
      hits.length === 2 &&
      hits[0].authorization === 'Bearer oauth-access-token-first' &&
      hits[1].authorization === 'Bearer oauth-access-token-second' &&
      hits[0].accountId === 'workspace-first' &&
      hits[1].accountId === 'workspace-second' &&
      hits.every((hit) => hit.body?.store === false && Array.isArray(hit.body?.input)) &&
      hits.every((hit) => hit.body?.max_output_tokens === undefined) &&
      firstCredential.authStatus === 'reauth_required' &&
      savedProvider.activeCredentialId === 'oauth-account-second',
    status: response.status,
    attempts: response.headers.get('x-local-relay-attempts'),
    hitAccounts: hits.map((hit) => hit.accountId),
    firstAccountStatus: firstCredential.authStatus,
    activeCredentialId: savedProvider.activeCredentialId,
    routeTestCredentialIds: routeTest.attempts.map((attempt) => attempt.credentialId),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  if (routeId) {
    try { await api(`/api/routes/${routeId}`, { method: 'DELETE' }) } catch {}
  }
  if (providerId) {
    try { await api(`/api/providers/${providerId}`, { method: 'DELETE' }) } catch {}
  }
  if (upstream) await new Promise((resolveClose) => upstream.close(resolveClose))
}

function assertRouteCredentialFailover(result) {
  const credentialIds = result.attempts?.map((attempt) => attempt.credentialId) || []
  if (
    result.ok !== true ||
    credentialIds.length !== 2 ||
    credentialIds[0] !== 'oauth-account-first' ||
    credentialIds[1] !== 'oauth-account-second' ||
    hits.length !== 2 ||
    !hits[0].authorization.includes('first') ||
    !hits[1].authorization.includes('second')
  ) {
    throw new Error(`Route test did not follow OAuth credential order: ${JSON.stringify({ result, hits })}`)
  }
}

function startUpstream() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch {}
    const authorization = String(req.headers.authorization || '')
    const accountId = String(req.headers['chatgpt-account-id'] || '')
    hits.push({ authorization, accountId, originator: req.headers.originator, url: req.url, body })
    res.setHeader('content-type', 'application/json')
    if (authorization.includes('first')) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: { message: 'first OAuth account expired' } }))
      return
    }
    res.statusCode = 200
    res.end(JSON.stringify({
      id: 'resp_oauth_failover',
      object: 'response',
      status: 'completed',
      model,
      output_text: 'OAUTH_FAILOVER_OK',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'OAUTH_FAILOVER_OK' }],
      }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }))
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
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
