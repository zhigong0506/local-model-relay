import { createHash, randomBytes } from 'node:crypto'
import { upstreamFetch } from '../upstream-fetch.mjs'

export const CODEX_OAUTH_CONFIG = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'http://localhost:1455/auth/callback',
  callbackHost: '127.0.0.1',
  callbackPort: 1455,
  callbackPath: '/auth/callback',
  scope: 'openid profile email offline_access',
})

const AUTH_NAMESPACE = 'https://api.openai.com/auth'
const MAX_TOKEN_LENGTH = 128 * 1024
const REFRESH_LEAD_MS = 5 * 60 * 1000
const MAX_REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000

export class OAuthTokenError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'OAuthTokenError'
    this.status = Number(options.status) || 0
    this.code = text(options.code)
    this.permanent = options.permanent === true
  }
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(32))
  return { verifier, challenge, state }
}

export function buildCodexAuthorizeUrl(pkce, config = CODEX_OAUTH_CONFIG) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
    state: pkce.state,
  })
  return `${config.authorizeUrl}?${params.toString().replace(/\+/g, '%20')}`
}

export async function exchangeCodexCode(code, verifier, options = {}) {
  const config = options.config || CODEX_OAUTH_CONFIG
  return requestToken(config.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: boundedToken(code, 'authorization code'),
    redirect_uri: config.redirectUri,
    code_verifier: boundedToken(verifier, 'PKCE verifier'),
  }, {
    ...options,
    encoding: 'form',
  })
}

export async function refreshCodexToken(refreshToken, options = {}) {
  const config = options.config || CODEX_OAUTH_CONFIG
  return requestToken(config.tokenUrl, {
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: boundedToken(refreshToken, 'refresh token'),
  }, {
    ...options,
    encoding: 'json',
  })
}

export function codexCredentialFromTokens(tokens, existing = {}, now = Date.now()) {
  if (!tokens || typeof tokens !== 'object') {
    throw new OAuthTokenError('OAuth token response is not an object.')
  }
  const accessToken = boundedToken(tokens.access_token || tokens.accessToken, 'access token')
  const refreshToken = optionalToken(tokens.refresh_token || tokens.refreshToken || existing.refreshToken)
  const idToken = optionalToken(tokens.id_token || tokens.idToken || existing.idToken)
  const identity = extractCodexIdentity(idToken, accessToken)
  const expiresAt = normalizeExpiry(tokens.expires_at || tokens.expiresAt, tokens.expires_in || tokens.expiresIn, accessToken, now)

  return {
    kind: refreshToken ? 'oauth' : 'access_token',
    providerType: 'codex',
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
    lastRefreshAt: new Date(now).toISOString(),
    email: text(tokens.email) || identity.email,
    accountId: text(tokens.accountId || tokens.chatgptAccountId) || identity.accountId,
    planType: text(tokens.planType || tokens.chatgptPlanType) || identity.planType,
    authStatus: 'active',
    lastAuthError: '',
  }
}

export function normalizeCodexImport(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OAuthTokenError('Each imported OAuth account must be an object.')
  }
  const providerData = input.providerSpecificData && typeof input.providerSpecificData === 'object'
    ? input.providerSpecificData
    : {}
  const credential = codexCredentialFromTokens({
    ...input,
    chatgptAccountId: input.chatgptAccountId || providerData.chatgptAccountId,
    chatgptPlanType: input.chatgptPlanType || providerData.chatgptPlanType,
  }, {}, now)
  return {
    ...credential,
    label: text(input.label || input.name) || credential.email || 'Codex OAuth',
    enabled: input.enabled !== false && input.isActive !== false,
    note: text(input.note),
    rate: positiveNumber(input.rate, 1),
    upstreamGroup: text(input.upstreamGroup),
  }
}

export function extractCodexIdentity(idToken, accessToken = '') {
  const idPayload = decodeJwtPayload(idToken) || {}
  const accessPayload = decodeJwtPayload(accessToken) || {}
  const idAuth = objectClaim(idPayload[AUTH_NAMESPACE])
  const accessAuth = objectClaim(accessPayload[AUTH_NAMESPACE])
  return {
    email: text(idPayload.email || accessPayload.email),
    accountId: text(
      idAuth.chatgpt_account_id ||
      idPayload.account_id ||
      accessAuth.chatgpt_account_id ||
      accessPayload.account_id,
    ),
    planType: text(
      idAuth.chatgpt_plan_type ||
      idPayload.plan_type ||
      accessAuth.chatgpt_plan_type ||
      accessPayload.plan_type,
    ),
  }
}

export function decodeJwtPayload(token) {
  const value = text(token)
  const parts = value.split('.')
  if (parts.length !== 3 || parts[1].length > MAX_TOKEN_LENGTH) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isCodexOAuthCredential(credential) {
  return Boolean(
    credential &&
    credential.providerType === 'codex' &&
    (credential.kind === 'oauth' || credential.kind === 'access_token'),
  )
}

export function shouldRefreshCodexCredential(credential, now = Date.now()) {
  if (!isCodexOAuthCredential(credential) || credential.kind !== 'oauth' || !credential.refreshToken) return false
  const expiresAt = Date.parse(credential.expiresAt || '')
  if (Number.isFinite(expiresAt) && expiresAt <= now + REFRESH_LEAD_MS) return true
  const lastRefreshAt = Date.parse(credential.lastRefreshAt || '')
  return !Number.isFinite(lastRefreshAt) || lastRefreshAt <= now - MAX_REFRESH_AGE_MS
}

export function isCredentialExpired(credential, now = Date.now()) {
  const expiresAt = Date.parse(credential?.expiresAt || '')
  return Number.isFinite(expiresAt) && expiresAt <= now
}

async function requestToken(url, fields, options) {
  const encoding = options.encoding === 'json' ? 'json' : 'form'
  const headers = {
    accept: 'application/json',
    'content-type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
  }
  const body = encoding === 'json' ? JSON.stringify(fields) : new URLSearchParams(fields).toString()
  const fetchImpl = options.fetchImpl || upstreamFetch
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: options.signal,
      proxyUrl: options.proxyUrl || '',
    })
  } catch (error) {
    throw new OAuthTokenError(`OAuth token request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const raw = await response.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = null
  }
  if (!response.ok) {
    const failure = classifyTokenError(data, raw, response.status)
    throw new OAuthTokenError(failure.message, failure)
  }
  if (!data?.access_token) throw new OAuthTokenError('OAuth token response did not include an access token.')
  return data
}

function classifyTokenError(data, raw, status) {
  const code = text(data?.error?.code || data?.error || data?.error_code)
  const description = text(data?.error_description || data?.error?.message || data?.message || raw)
    .replace(/\s+/g, ' ')
    .slice(0, 500)
  const combined = `${code} ${description}`.toLowerCase()
  const permanent = [
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
    'invalid_grant',
  ].some((marker) => combined.includes(marker))
  return {
    status,
    code,
    permanent,
    message: description ? `OAuth token request failed: ${description}` : `OAuth token request failed with HTTP ${status}.`,
  }
}

function normalizeExpiry(value, expiresIn, accessToken, now) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
  }
  const seconds = Number(expiresIn)
  if (Number.isFinite(seconds) && seconds > 0) return new Date(now + seconds * 1000).toISOString()
  const payload = decodeJwtPayload(accessToken)
  if (Number.isFinite(Number(payload?.exp))) return new Date(Number(payload.exp) * 1000).toISOString()
  return ''
}

function boundedToken(value, label) {
  const result = optionalToken(value)
  if (!result) throw new OAuthTokenError(`${label} is required.`)
  return result
}

function optionalToken(value) {
  const result = text(value)
  if (result.length > MAX_TOKEN_LENGTH) throw new OAuthTokenError('OAuth token is too large.')
  return result
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function objectClaim(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}
