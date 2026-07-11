import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { ConfigStore, HttpError } from './config-store.mjs'
import { getCachedSystemProxy, getOutboundRuntime } from './outbound-proxy.mjs'
import { StateStore } from './state-store.mjs'
import { handleProxyRequest } from './proxy.mjs'
import { publicDir, rootDir } from './paths.mjs'
import { previewRoute, realTestProvider, syncProviderCredentialUsage, testProvider } from './provider-test.mjs'
import { fetchSpeedTestModels, runSpeedTest } from './speed-test.mjs'

const configStore = new ConfigStore()
const stateStore = new StateStore()
const runtimeConfig = configStore.get()
const runtimeListenHost = normalizeRuntimeHost(process.env.LOCAL_MODEL_RELAY_HOST, runtimeConfig.service.listenHost)
const runtimeListenPort = normalizeRuntimePort(process.env.LOCAL_MODEL_RELAY_PORT, runtimeConfig.service.listenPort)
stateStore.pruneProviders(runtimeConfig.providers.map((provider) => provider.id))
const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024

const server = createServer(async (req, res) => {
  try {
    await routeRequest(req, res)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    sendJson(res, status, {
      error: {
        type: error instanceof HttpError ? error.code : 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
})

server.on('error', (error) => {
  const code = error && typeof error === 'object' ? error.code : ''
  if (code === 'EADDRINUSE') {
    relayError(`failed to start: ${runtimeConfig.service.listenHost}:${runtimeConfig.service.listenPort} is already in use.`)
  } else if (code === 'EACCES') {
    relayError(`failed to start: no permission to listen on ${runtimeConfig.service.listenHost}:${runtimeConfig.service.listenPort}.`)
  } else {
    relayError(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(1)
})

server.listen(runtimeListenPort, runtimeListenHost, () => {
  const address = `http://${runtimeListenHost}:${runtimeListenPort}`
  relayLog(`admin: ${address}/admin`)
  relayLog(`local api: ${address}/v1`)
  relayLog(`outbound: ${formatOutboundLog(currentOutboundRuntime(runtimeConfig.service))}`)
  relayLog(`project: ${rootDir}`)
})

async function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)

  if (url.pathname.startsWith('/api/')) {
    assertLocalAdminClient(req)
    assertAllowedHost(req.headers.host)
    assertTrustedBrowserSource(req)
  }

  if (url.pathname === '/') {
    res.statusCode = 302
    res.setHeader('location', '/admin')
    res.end()
    return
  }

  if (url.pathname === '/admin') {
    return serveStaticFile(res, join(publicDir, 'index.html'))
  }

  if (url.pathname.startsWith('/assets/')) {
    return serveStaticFile(res, join(publicDir, url.pathname.replace('/assets/', '')))
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, configStore.getPublic())
  }

  if (url.pathname === '/api/config/export' && req.method === 'GET') {
    return sendJson(res, 200, configStore.exportConfig(url.searchParams.get('secrets') === '1'))
  }

  if (url.pathname === '/api/config/import' && req.method === 'POST') {
    const config = configStore.importConfig(await readJson(req))
    stateStore.pruneProviders(config.providers.map((provider) => provider.id))
    return sendJson(res, 200, config)
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/state/logs' && req.method === 'DELETE') {
    stateStore.clearRequestLog()
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/state/usage' && req.method === 'DELETE') {
    stateStore.clearUsage()
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/speed-test/models' && req.method === 'POST') {
    const config = configStore.get()
    return sendJson(res, 200, await fetchSpeedTestModels(await readJson(req), config.service))
  }

  if (url.pathname === '/api/speed-test/run' && req.method === 'POST') {
    const config = configStore.get()
    return sendJson(res, 200, await runSpeedTest(await readJson(req), config.service))
  }

  if (url.pathname === '/api/routing/start' && req.method === 'POST') {
    const body = await readJson(req)
    const providerId = String(body.providerId || '').trim()
    const config = configStore.get()
    if (providerId && !config.providers.some((provider) => provider.id === providerId)) {
      throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    }
    stateStore.setStartProvider(providerId, body.mode)
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/routing/start' && req.method === 'DELETE') {
    stateStore.clearStartProvider()
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/service' && req.method === 'PATCH') {
    return sendJson(res, 200, configStore.updateService(await readJson(req)))
  }

  if (url.pathname === '/api/service/enabled' && req.method === 'POST') {
    const body = await readJson(req)
    return sendJson(res, 200, configStore.setEnabled(Boolean(body.enabled)))
  }

  if (url.pathname === '/api/providers' && req.method === 'POST') {
    return sendJson(res, 201, configStore.createProvider(await readJson(req)))
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/)
  if (providerMatch && req.method === 'PATCH') {
    return sendJson(res, 200, configStore.updateProvider(providerMatch[1], await readJson(req)))
  }
  if (providerMatch && req.method === 'DELETE') {
    const config = configStore.deleteProvider(providerMatch[1])
    stateStore.pruneProviders(config.providers.map((provider) => provider.id))
    return sendJson(res, 200, config)
  }

  const providerCredentialMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/credential$/)
  if (providerCredentialMatch && req.method === 'POST') {
    const body = await readJson(req)
    return sendJson(res, 200, configStore.setActiveCredential(providerCredentialMatch[1], String(body.credentialId || '')))
  }

  const providerTestMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/)
  if (providerTestMatch && req.method === 'POST') {
    const config = configStore.get()
    const provider = config.providers.find((item) => item.id === providerTestMatch[1])
    if (!provider) throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    return sendJson(res, 200, await testProvider(provider, null, config.service))
  }

  const providerRealTestMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/real-test$/)
  if (providerRealTestMatch && req.method === 'POST') {
    const config = configStore.get()
    const provider = config.providers.find((item) => item.id === providerRealTestMatch[1])
    if (!provider) throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    const result = await realTestProvider(provider, await readJson(req), config.service)
    if (!result.skipped) recordRealTestResult(provider, result)
    return sendJson(res, 200, result)
  }

  const providerUsageSyncMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/usage-sync$/)
  if (providerUsageSyncMatch && req.method === 'POST') {
    const config = configStore.get()
    const provider = config.providers.find((item) => item.id === providerUsageSyncMatch[1])
    if (!provider) throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    const result = await syncProviderCredentialUsage(provider, await readJson(req), config.service)
    if (result.ok && result.snapshot) {
      result.upstreamUsage = stateStore.recordUpstreamUsage(provider.id, result.credentialId, result.snapshot)
      result.provider = configStore.updateCredentialMetadata(provider.id, result.credentialId, {
        upstreamGroup: result.snapshot.group,
        upstreamStatus: result.snapshot.status,
      })
    }
    return sendJson(res, 200, result)
  }

  if (url.pathname === '/api/routes' && req.method === 'POST') {
    return sendJson(res, 201, configStore.createRoute(await readJson(req)))
  }

  const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)$/)
  if (routeMatch && req.method === 'PATCH') {
    return sendJson(res, 200, configStore.updateRoute(routeMatch[1], await readJson(req)))
  }
  if (routeMatch && req.method === 'DELETE') {
    return sendJson(res, 200, configStore.deleteRoute(routeMatch[1]))
  }

  if (url.pathname === '/api/route-preview' && req.method === 'POST') {
    const body = await readJson(req)
    return sendJson(res, 200, {
      candidates: previewRoute(configStore.get(), stateStore, String(body.model || '')),
    })
  }

  const stateResetMatch = url.pathname.match(/^\/api\/state\/providers\/([^/]+)\/reset$/)
  if (stateResetMatch && req.method === 'POST') {
    return sendJson(res, 200, stateStore.resetProvider(stateResetMatch[1]))
  }

  if (url.pathname === '/api/process/exit' && req.method === 'POST') {
    sendJson(res, 200, { ok: true })
    relayLog('shutdown requested through the management API')
    setTimeout(() => process.exit(0), 150)
    return
  }

  if (url.pathname === '/health') {
    const config = configStore.get()
    return sendJson(res, 200, {
      ok: true,
      enabled: config.service.enabled,
      providers: config.providers.length,
      routes: config.routes.length,
      admin: '/admin',
      outbound: currentOutboundRuntime(config.service),
    })
  }

  if (url.pathname.startsWith('/v1')) {
    return handleProxyRequest(req, res, { configStore, stateStore })
  }

  sendJson(res, 404, {
    error: {
      type: 'not_found',
      message: 'Not found.',
    },
  })
}

function serveStaticFile(res, filePath) {
  const normalized = resolve(filePath)
  if (!isInsideDirectory(publicDir, normalized) || !existsSync(normalized)) {
    return sendJson(res, 404, { error: { type: 'not_found', message: 'Not found.' } })
  }

  res.statusCode = 200
  res.setHeader('content-type', contentType(normalized))
  createReadStream(normalized).pipe(res)
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body, null, 2))
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (Number(req.headers['content-length'] || 0) > 0 && !contentType.includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Management API only accepts JSON request bodies.')
  }

  const text = await new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    req.on('data', (chunk) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_ADMIN_BODY_BYTES) {
        const error = new HttpError(413, 'request_too_large', 'Request body is too large.')
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.')
  }
}

function recordRealTestResult(provider, result) {
  if (provider.tags?.includes('tmp-real-test-model')) return

  const latencyMs = Number(result.latencyMs) || 0
  const config = configStore.get()
  if (result.ok) {
    stateStore.markSuccess(provider.id, { status: result.status || 200, latencyMs })
    if (result.usage) {
      stateStore.recordUsage(provider.id, result.model, result.usage, {
        credentialId: result.credentialId || provider.activeCredentialId || '',
        latencyMs,
      })
    }
  } else {
    stateStore.markFailure(provider.id, {
      status: result.status || 0,
      message: result.message || 'Real test failed.',
      latencyMs,
      cooldownSeconds: 0,
    })
  }
  if (config.service.logRequests) {
    stateStore.addRequestLog({
      testType: 'real_test',
      method: 'TEST',
      path: result.wireApi === 'responses' ? '/v1/responses' : '/v1/chat/completions',
      model: result.model,
      routedModel: result.model,
      providerId: provider.id,
      providerName: provider.name,
      credentialId: result.credentialId || provider.activeCredentialId || '',
      credentialLabel: result.credentialLabel || '',
      status: result.status || 0,
      ok: Boolean(result.ok),
      attempts: [{
        providerId: provider.id,
        providerName: provider.name,
        credentialId: result.credentialId || provider.activeCredentialId || '',
        credentialLabel: result.credentialLabel || '',
        model: result.model,
        status: result.status || 0,
        latencyMs,
        error: result.ok ? null : result.message || 'Real test failed.',
        outcome: result.ok ? 'real_test_success' : 'real_test_failed',
      }],
      durationMs: latencyMs,
      outcome: result.ok ? 'real_test_success' : 'real_test_failed',
      stream: false,
      usage: result.ok ? result.usage : null,
      error: result.ok ? undefined : result.message || 'Real test failed.',
    }, config.service.requestLogLimit)
  }
}

function relayLog(message) {
  console.log(`[${new Date().toISOString()}] [relay] ${message}`)
}

function relayError(message) {
  console.error(`[${new Date().toISOString()}] [relay] ${message}`)
}

function runtimeState() {
  const config = configStore.get()
  return {
    ...stateStore.getPublic(),
    outbound: currentOutboundRuntime(config.service),
  }
}

function currentOutboundRuntime(service) {
  return getOutboundRuntime(service, process.env, process.execArgv, {
    systemProxy: getCachedSystemProxy(process.env),
  })
}

function formatOutboundLog(outbound) {
  if (outbound.effectiveMode === 'direct') return outbound.message || 'direct'
  return `${outbound.effectiveMode} (${outbound.effectiveProxyUrl || 'proxy'})`
}

function assertAllowedHost(rawHost = '') {
  const host = String(rawHost || '').trim().toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return
  throw new HttpError(403, 'forbidden_host', 'Management API only accepts localhost requests.')
}

function assertTrustedBrowserSource(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return

  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw new HttpError(403, 'forbidden_origin', 'Management API only accepts same-origin browser requests.')
  }

  const origin = String(req.headers.origin || '')
  if (origin && !isAllowedLocalOrigin(origin)) {
    throw new HttpError(403, 'forbidden_origin', 'Management API only accepts localhost origins.')
  }

  const referer = String(req.headers.referer || '')
  if (!origin && referer && !isAllowedLocalOrigin(referer)) {
    throw new HttpError(403, 'forbidden_origin', 'Management API only accepts localhost referrers.')
  }
}

function isAllowedLocalOrigin(value) {
  try {
    const url = new URL(value)
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
      (!url.port || Number(url.port) === runtimeListenPort)
    )
  } catch {
    return false
  }
}

function assertLocalAdminClient(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase()
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return
  throw new HttpError(403, 'forbidden_client', 'Management API only accepts local loopback clients.')
}

function normalizeRuntimeHost(value, fallback) {
  const host = String(value || '').trim()
  return host || fallback
}

function normalizeRuntimePort(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

function isInsideDirectory(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
