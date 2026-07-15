import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ConfigStore } from '../src/config-store.mjs'
import { CodexOAuthManager } from '../src/oauth/codex-oauth-manager.mjs'
import {
  buildCodexAuthorizeUrl,
  createPkcePair,
  extractCodexIdentity,
  normalizeCodexImport,
} from '../src/oauth/codex-oauth.mjs'
import { prepareCredential } from '../src/oauth/token-refresh.mjs'
import { shouldRequireOAuthReauth } from '../src/proxy.mjs'
import { normalizeCodexOAuthRequest, resolveCodexOAuthSessionId } from '../src/oauth/codex-request.mjs'
import { testProvider } from '../src/provider-test.mjs'

const tempRoot = await mkdtemp(resolve(tmpdir(), 'local-model-relay-oauth-test-'))
const tokenRequests = []
const tokenServer = await startServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/backend-api/codex/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ models: [{ slug: 'gpt-oauth-test' }] }))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  tokenRequests.push({ url: req.url, contentType: req.headers['content-type'], raw })
  const refresh = req.headers['content-type']?.includes('json')
  await new Promise((resolveDelay) => setTimeout(resolveDelay, refresh ? 40 : 0))
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    access_token: fakeJwt({ email: 'oauth@example.test', account_id: 'workspace-test', exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: refresh ? 'rotated-refresh-token' : 'initial-refresh-token',
    id_token: fakeJwt({
      email: 'oauth@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-test',
        chatgpt_plan_type: 'plus',
      },
    }),
    expires_in: 3600,
  }))
})
const callbackPort = await reservePort()
const oauthConfig = {
  clientId: 'test-client',
  authorizeUrl: 'https://auth.example.test/oauth/authorize',
  tokenUrl: `http://127.0.0.1:${tokenServer.address().port}/token`,
  redirectUri: `http://localhost:${callbackPort}/auth/callback`,
  callbackHost: '127.0.0.1',
  callbackPort,
  callbackPath: '/auth/callback',
  scope: 'openid offline_access',
}

try {
  const pkce = createPkcePair()
  assert.ok(pkce.verifier.length >= 43)
  assert.ok(pkce.challenge.length >= 43)
  assert.notEqual(pkce.verifier, pkce.challenge)
  const authUrl = new URL(buildCodexAuthorizeUrl(pkce, oauthConfig))
  assert.equal(authUrl.searchParams.get('state'), pkce.state)
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authUrl.searchParams.get('redirect_uri'), oauthConfig.redirectUri)

  const identity = extractCodexIdentity(fakeJwt({
    email: 'identity@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-identity',
      chatgpt_plan_type: 'team',
    },
  }))
  assert.deepEqual(identity, {
    email: 'identity@example.test',
    accountId: 'workspace-identity',
    planType: 'team',
  })
  const mergedIdentity = extractCodexIdentity(
    fakeJwt({ email: 'merged@example.test' }),
    fakeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-from-access-token',
        chatgpt_plan_type: 'business',
      },
    }),
  )
  assert.equal(mergedIdentity.accountId, 'workspace-from-access-token')
  assert.equal(mergedIdentity.planType, 'business')
  assert.equal(normalizeCodexImport({ accessToken: fakeJwt({ exp: 4102444800 }) }).kind, 'access_token')
  const importedWorkspace = normalizeCodexImport({
    accessToken: fakeJwt({ exp: 4102444800 }),
    providerSpecificData: {
      chatgptAccountId: 'workspace-from-9router',
      chatgptPlanType: 'pro',
    },
  })
  assert.equal(importedWorkspace.accountId, 'workspace-from-9router')
  assert.equal(importedWorkspace.planType, 'pro')

  const codexBody = normalizeCodexOAuthRequest({
    model: 'gpt-test',
    input: 'hello',
    stream: true,
    max_output_tokens: 8,
    temperature: 0,
    reasoning_effort: 'max',
    tools: [{
      type: 'function',
      function: {
        name: 'ping',
        description: 'Ping once',
        parameters: { type: 'object', properties: {} },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'ping' } },
  }, { sessionId: 'session-test' })
  assert.equal(codexBody.input[0].content[0].text, 'hello')
  assert.equal(codexBody.store, false)
  assert.equal(codexBody.reasoning.effort, 'xhigh')
  assert.equal(codexBody.max_output_tokens, undefined)
  assert.equal(codexBody.temperature, undefined)
  assert.equal(codexBody.tools[0].name, 'ping')
  assert.deepEqual(codexBody.tool_choice, { type: 'function', name: 'ping' })
  assert.equal(codexBody.prompt_cache_key, 'session-test')
  assert.equal(resolveCodexOAuthSessionId({ 'x-local-relay-session': 'stable-session' }, {}), 'stable-session')

  const store = new ConfigStore(resolve(tempRoot, 'config.json'))
  const manager = new CodexOAuthManager(store, { oauthConfig })
  const [started, concurrentStarted] = await Promise.all([manager.start(), manager.start()])
  assert.equal(started.callbackMode, 'automatic')
  assert.equal(concurrentStarted.callbackMode, 'automatic')
  manager.cancel(concurrentStarted.state)
  const mismatchSession = await manager.start()
  await assert.rejects(
    manager.complete({
      state: mismatchSession.state,
      callbackUrl: `http://localhost:${callbackPort}/auth/callback?state=wrong-state&code=test-code`,
    }),
    /state/,
  )
  manager.cancel(mismatchSession.state)
  const callback = await fetch(`http://127.0.0.1:${callbackPort}/auth/callback?state=${encodeURIComponent(started.state)}&code=test-code`)
  assert.equal(callback.status, 200)
  const status = manager.status(started.state)
  assert.equal(status.status, 'done')
  assert.ok(status.connection?.credentialId)
  assert.equal(JSON.stringify(status).includes('initial-refresh-token'), false)

  const provider = store.get().providers.find((item) => item.providerType === 'codex_oauth')
  assert.ok(provider)
  const credential = provider.credentials[0]
  assert.equal(credential.accountId, 'workspace-test')
  assert.equal(credential.kind, 'oauth')
  assert.equal(store.getPublic().providers[0].credentials[0].refreshToken, undefined)

  const [firstRefresh, secondRefresh] = await Promise.all([
    prepareCredential(store, provider, credential, store.get().service, {
      force: true,
      oauthConfig,
      fetchImpl: fetch,
    }),
    prepareCredential(store, provider, credential, store.get().service, {
      force: true,
      oauthConfig,
      fetchImpl: fetch,
    }),
  ])
  assert.equal(firstRefresh.refreshToken, 'rotated-refresh-token')
  assert.equal(secondRefresh.refreshToken, 'rotated-refresh-token')
  assert.equal(tokenRequests.filter((request) => request.contentType?.includes('json')).length, 1)
  assert.equal(shouldRequireOAuthReauth(401, credential, { attempted: true, ok: false, permanent: false }), false)
  assert.equal(shouldRequireOAuthReauth(401, credential, { attempted: true, ok: false, permanent: true }), true)
  assert.equal(shouldRequireOAuthReauth(401, { ...credential, refreshToken: '' }), true)

  const refreshableProvider = store.createProvider({
    name: 'Refreshable OAuth test',
    providerType: 'codex_oauth',
    baseUrl: `http://127.0.0.1:${tokenServer.address().port}/backend-api/codex`,
    credentials: [{
      id: 'oauth-refreshable-test',
      label: 'Expired OAuth test',
      kind: 'oauth',
      providerType: 'codex',
      accessToken: fakeJwt({ exp: 1 }),
      refreshToken: 'refreshable-test-token',
      expiresAt: new Date(0).toISOString(),
      enabled: true,
    }],
    activeCredentialId: 'oauth-refreshable-test',
    authMode: 'authorization',
    wireApi: 'responses',
    models: ['gpt-oauth-test'],
  })
  const refreshableInternal = store.get().providers.find((item) => item.id === refreshableProvider.id)
  const providerTest = await testProvider(refreshableInternal, null, store.get().service, {
    configStore: store,
    oauthConfig,
    fetchImpl: fetch,
  })
  assert.equal(providerTest.ok, true)
  assert.deepEqual(providerTest.models, ['gpt-oauth-test'])
  assert.equal(tokenRequests.filter((request) => request.contentType?.includes('json')).length, 2)
  await manager.close()

  console.log(JSON.stringify({
    ok: true,
    pkceVerified: true,
    callbackStateVerified: true,
    tokensRedactedFromPublicState: true,
    workspaceIdentityExtracted: true,
    concurrentRefreshDeduplicated: true,
    providerTestRefreshesExpiredOAuth: true,
  }, null, 2))
} finally {
  await new Promise((resolveClose) => tokenServer.close(resolveClose))
  await rm(tempRoot, { recursive: true, force: true })
}

function fakeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}
