import { getCachedSystemProxy, resolveProviderOutboundProxy } from '../outbound-proxy.mjs'
import {
  OAuthTokenError,
  codexCredentialFromTokens,
  isCodexOAuthCredential,
  isCredentialExpired,
  refreshCodexToken,
  shouldRefreshCodexCredential,
} from './codex-oauth.mjs'

const refreshLocks = new Map()

export class CredentialRefreshError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'CredentialRefreshError'
    this.code = options.code || 'oauth_refresh_failed'
    this.permanent = options.permanent === true
  }
}

export async function prepareCredential(configStore, provider, credential, serviceConfig, options = {}) {
  const isCodex = isCodexOAuthCredential(credential)
  if (!isCodex) return credential
  if (credential.authStatus === 'reauth_required') {
    throw new CredentialRefreshError('Codex OAuth account needs to sign in again.', {
      code: 'oauth_reauth_required',
      permanent: true,
    })
  }

  const force = options.force === true
  const needsRefresh = force || shouldRefreshCodexCredential(credential)
  if (!needsRefresh) {
    if (isCredentialExpired(credential)) {
      throw new CredentialRefreshError('Codex access token has expired and cannot be refreshed.', {
        code: 'oauth_token_expired',
        permanent: !credential.refreshToken,
      })
    }
    return credential
  }
  if (!credential.refreshToken) {
    throw new CredentialRefreshError('Imported Codex access token cannot be refreshed. Sign in again or import a new token.', {
      code: 'oauth_token_expired',
      permanent: true,
    })
  }

  const lockKey = `${provider.id}:${credential.id}`
  if (refreshLocks.has(lockKey)) return refreshLocks.get(lockKey)
  const task = refreshLocked(configStore, provider, credential, serviceConfig, force, options)
    .finally(() => refreshLocks.delete(lockKey))
  refreshLocks.set(lockKey, task)
  return task
}

async function refreshLocked(configStore, provider, credential, serviceConfig, force, options) {
  const latest = configStore.getCredential(provider.id, credential.id) || credential
  const shouldRefresh = shouldRefreshCodexCredential(latest)
  if (!force && !shouldRefresh && !isCredentialExpired(latest)) return latest
  const proxyUrl = resolveProviderOutboundProxy(provider, serviceConfig, {
    systemProxy: getCachedSystemProxy(),
  }).proxyUrl

  try {
    const tokens = await refreshCodexToken(latest.refreshToken, {
      proxyUrl,
      config: options.oauthConfig,
      fetchImpl: options.fetchImpl,
    })
    const patch = codexCredentialFromTokens(tokens, latest)
    return configStore.updateCredentialAuth(provider.id, credential.id, patch)
  } catch (error) {
    const permanent = error instanceof OAuthTokenError && error.permanent
    if (permanent) {
      configStore.updateCredentialAuth(provider.id, credential.id, {
        authStatus: 'reauth_required',
        lastAuthError: error.code || 'invalid_grant',
      })
    }
    throw new CredentialRefreshError(error instanceof Error ? error.message : String(error), {
      code: error?.code || 'oauth_refresh_failed',
      permanent,
    })
  }
}
