import { createServer } from 'node:http'
import { getCachedSystemProxy, resolveServiceOutboundProxy } from '../outbound-proxy.mjs'
import {
  CODEX_OAUTH_CONFIG,
  buildCodexAuthorizeUrl,
  codexCredentialFromTokens,
  createPkcePair,
  exchangeCodexCode,
  normalizeCodexImport,
} from './codex-oauth.mjs'

const SESSION_TTL_MS = 5 * 60 * 1000
const MAX_IMPORT_ACCOUNTS = 20

export class CodexOAuthManager {
  constructor(configStore, options = {}) {
    this.configStore = configStore
    this.oauthConfig = { ...CODEX_OAUTH_CONFIG, ...(options.oauthConfig || {}) }
    this.sessions = new Map()
    this.callbackServer = null
    this.callbackStartPromise = null
  }

  async start(input = {}) {
    this.prune()
    const pkce = createPkcePair()
    const now = Date.now()
    const session = {
      state: pkce.state,
      verifier: pkce.verifier,
      providerId: text(input.providerId),
      status: 'pending',
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      error: '',
      connection: null,
    }
    this.sessions.set(session.state, session)
    session.callbackMode = await this.ensureCallbackServer() ? 'automatic' : 'manual'
    return {
      state: session.state,
      status: session.status,
      authUrl: buildCodexAuthorizeUrl({ ...pkce }, this.oauthConfig),
      redirectUri: this.oauthConfig.redirectUri,
      callbackMode: session.callbackMode,
      expiresAt: new Date(session.expiresAt).toISOString(),
    }
  }

  status(state) {
    this.prune()
    const session = this.sessions.get(text(state))
    if (!session) return { status: 'unknown' }
    return publicSession(session)
  }

  async complete(input = {}) {
    let state = text(input.state)
    let code = text(input.code)
    const callbackUrl = text(input.callbackUrl)
    if (callbackUrl) {
      let parsed
      try {
        parsed = new URL(callbackUrl)
      } catch {
        throw new Error('回调地址格式无效。')
      }
      const callbackState = text(parsed.searchParams.get('state'))
      if (state && callbackState && state !== callbackState) {
        throw new Error('OAuth 回调 state 与当前登录会话不一致。')
      }
      state ||= callbackState
      code ||= text(parsed.searchParams.get('code'))
      const error = text(parsed.searchParams.get('error_description') || parsed.searchParams.get('error'))
      if (error) throw new Error(error)
    }
    return this.finish(state, code)
  }

  cancel(state) {
    const session = this.sessions.get(text(state))
    if (session && session.status === 'pending') {
      session.status = 'cancelled'
      session.error = 'Login cancelled.'
    }
    this.closeCallbackIfIdle()
    return session ? publicSession(session) : { status: 'unknown' }
  }

  importAccounts(input = {}) {
    const raw = Array.isArray(input.accounts)
      ? input.accounts
      : Array.isArray(input)
        ? input
        : input.account && typeof input.account === 'object'
          ? [input.account]
          : [input]
    if (raw.length === 0 || raw.length > MAX_IMPORT_ACCOUNTS) {
      throw new Error(`一次需要导入 1-${MAX_IMPORT_ACCOUNTS} 个 OAuth 账号。`)
    }
    const results = []
    for (const account of raw) {
      const credential = normalizeCodexImport(account)
      results.push(this.configStore.upsertCodexOAuthCredential(text(input.providerId), credential))
    }
    return {
      imported: results.length,
      connections: results.map(({ provider, credential }) => ({
        providerId: provider.id,
        providerName: provider.name,
        credentialId: credential.id,
        credentialLabel: credential.label,
        kind: credential.kind,
      })),
    }
  }

  async close() {
    const server = this.callbackServer
    this.callbackServer = null
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  async finish(state, code) {
    this.prune()
    const session = this.sessions.get(text(state))
    if (!session) throw new Error('OAuth 登录会话不存在或已经过期。')
    if (session.status === 'done') return publicSession(session)
    if (session.status === 'exchanging') return publicSession(session)
    if (session.status !== 'pending') throw new Error(session.error || 'OAuth 登录会话不可用。')
    if (!code || code.length > 16 * 1024) throw new Error('OAuth 回调中缺少有效授权码。')

    session.status = 'exchanging'
    try {
      const service = this.configStore.get().service
      const proxyUrl = resolveServiceOutboundProxy(service, { systemProxy: getCachedSystemProxy() }).proxyUrl
      const tokens = await exchangeCodexCode(code, session.verifier, {
        config: this.oauthConfig,
        proxyUrl,
      })
      const credential = codexCredentialFromTokens(tokens)
      const saved = this.configStore.upsertCodexOAuthCredential(session.providerId, credential)
      session.status = 'done'
      session.connection = {
        providerId: saved.provider.id,
        providerName: saved.provider.name,
        credentialId: saved.credential.id,
        credentialLabel: saved.credential.label,
      }
      session.verifier = ''
      return publicSession(session)
    } catch (error) {
      session.status = 'error'
      session.error = safeError(error)
      session.verifier = ''
      throw new Error(session.error)
    } finally {
      this.closeCallbackIfIdle()
    }
  }

  prune(now = Date.now()) {
    for (const [state, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(state)
    }
    this.closeCallbackIfIdle()
  }

  ensureCallbackServer() {
    if (this.callbackServer?.listening) return Promise.resolve(true)
    if (this.callbackStartPromise) return this.callbackStartPromise
    const pending = new Promise((resolve) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || '/', this.oauthConfig.redirectUri)
        if (req.method !== 'GET' || url.pathname !== this.oauthConfig.callbackPath) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Not found')
          return
        }
        const state = text(url.searchParams.get('state'))
        const code = text(url.searchParams.get('code'))
        const upstreamError = text(url.searchParams.get('error_description') || url.searchParams.get('error'))
        try {
          if (upstreamError) throw new Error(upstreamError)
          await this.finish(state, code)
          sendCallbackPage(res, true, 'Codex OAuth 登录完成，可以关闭此窗口。')
        } catch (error) {
          sendCallbackPage(res, false, safeError(error))
        }
      })
      let settled = false
      server.once('error', () => {
        if (settled) return
        settled = true
        resolve(false)
      })
      server.listen(this.oauthConfig.callbackPort, this.oauthConfig.callbackHost, () => {
        if (settled) return
        settled = true
        this.callbackServer = server
        resolve(true)
      })
    })
    this.callbackStartPromise = pending.finally(() => {
      if (this.callbackStartPromise) this.callbackStartPromise = null
    })
    return this.callbackStartPromise
  }

  closeCallbackIfIdle() {
    if ([...this.sessions.values()].some((session) => ['pending', 'exchanging'].includes(session.status))) return
    const server = this.callbackServer
    this.callbackServer = null
    if (server?.listening) server.close()
  }
}

function publicSession(session) {
  return {
    state: session.state,
    status: session.status,
    callbackMode: session.callbackMode || 'manual',
    expiresAt: new Date(session.expiresAt).toISOString(),
    error: session.error,
    connection: session.connection,
  }
}

function sendCallbackPage(res, ok, message) {
  const title = ok ? '登录完成' : '登录失败'
  const color = ok ? '#15836d' : '#b5474f'
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f7f8;color:#243136}.box{max-width:560px;padding:28px;border:1px solid #dbe5e7;border-radius:16px;background:white;box-shadow:0 18px 50px #2431361f}h1{margin:0 0 12px;color:${color};font-size:24px}p{margin:0;line-height:1.7}</style><div class="box"><h1>${title}</h1><p>${escapeHtml(message)}</p></div>`
  res.writeHead(ok ? 200 : 400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error || 'OAuth login failed.')
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .slice(0, 800)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}
