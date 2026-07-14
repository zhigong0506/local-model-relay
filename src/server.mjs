import { createServer } from 'node:http'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { ConfigStore, HttpError, resolveActiveCredential, resolveActiveKey } from './config-store.mjs'
import { getCachedSystemProxy, getOutboundRuntime } from './outbound-proxy.mjs'
import { StateStore } from './state-store.mjs'
import { handleProxyRequest } from './proxy.mjs'
import { publicDir, rootDir } from './paths.mjs'
import { codexCompatibilityTestProvider, previewRoute, realTestProvider, realTestRoute, testProvider } from './provider-test.mjs'
import { fetchSpeedTestModels, runSpeedTest } from './speed-test.mjs'
import { describeRoutingSkip, describeUpstreamFailure, redactSecretText } from './upstream-diagnostics.mjs'
import { diagnoseLog, testDiagnosticsLlm } from './diagnostics-llm.mjs'

const configStore = new ConfigStore()
const stateStore = new StateStore()
const runtimeConfig = configStore.get()
const runtimeListenHost = normalizeRuntimeHost(process.env.LOCAL_MODEL_RELAY_HOST, runtimeConfig.service.listenHost)
const runtimeListenPort = normalizeRuntimePort(process.env.LOCAL_MODEL_RELAY_PORT, runtimeConfig.service.listenPort)
stateStore.pruneProviders(runtimeConfig.providers.map((provider) => provider.id))
const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024
const RUNTIME_PROTOCOL_VERSION = 1
const SERVER_STARTED_AT_MS = Date.now()
const SERVER_STARTED_AT = new Date(SERVER_STARTED_AT_MS).toISOString()

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
    relayError(`failed to start: ${runtimeListenHost}:${runtimeListenPort} is already in use.`)
  } else if (code === 'EACCES') {
    relayError(`failed to start: no permission to listen on ${runtimeListenHost}:${runtimeListenPort}.`)
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

  if (url.pathname === '/api/state/summary' && req.method === 'GET') {
    return sendJson(res, 200, runtimeSummaryState())
  }

  if (url.pathname === '/api/state/logs' && req.method === 'DELETE') {
    stateStore.clearRequestLog()
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/state/usage' && req.method === 'DELETE') {
    stateStore.clearUsage()
    return sendJson(res, 200, runtimeState())
  }

  if (url.pathname === '/api/diagnostics/ai' && req.method === 'POST') {
    const config = configStore.get()
    const body = await readJson(req)
    return sendJson(res, 200, await diagnoseLog(body.log, config.service))
  }

  if (url.pathname === '/api/diagnostics/ai/test' && req.method === 'POST') {
    const config = configStore.get()
    return sendJson(res, 200, await testDiagnosticsLlm(config.service))
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
    const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : ''
    const config = configStore.get()
    if (body.mode !== undefined && !['auto', 'locked', 'pinned'].includes(mode)) {
      throw new HttpError(400, 'invalid_routing_mode', 'Routing mode must be auto, locked, or pinned.')
    }
    if (providerId && !config.providers.some((provider) => provider.id === providerId)) {
      throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    }
    if (mode === 'pinned' && !providerId) {
      throw new HttpError(400, 'pinned_start_required', 'Choose a start provider before enabling pinned routing.')
    }
    stateStore.setStartProvider(providerId, body.mode === undefined ? undefined : mode)
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

  if (url.pathname === '/api/provider-groups' && req.method === 'POST') {
    return sendJson(res, 201, configStore.createProviderGroup(await readJson(req)))
  }

  const providerGroupMatch = url.pathname.match(/^\/api\/provider-groups\/([^/]+)$/)
  if (providerGroupMatch && req.method === 'PATCH') {
    return sendJson(res, 200, configStore.updateProviderGroup(providerGroupMatch[1], await readJson(req)))
  }
  if (providerGroupMatch && req.method === 'DELETE') {
    return sendJson(res, 200, configStore.deleteProviderGroup(providerGroupMatch[1]))
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
    const result = await testProvider(provider, null, config.service)
    recordProviderTestResult(provider, result)
    return sendJson(res, 200, result)
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

  const providerCodexTestMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/codex-test$/)
  if (providerCodexTestMatch && req.method === 'POST') {
    const config = configStore.get()
    const provider = config.providers.find((item) => item.id === providerCodexTestMatch[1])
    if (!provider) throw new HttpError(404, 'provider_not_found', 'Provider not found.')
    const result = await codexCompatibilityTestProvider(provider, await readJson(req), config.service)
    if (!result.skipped) {
      const current = provider.capabilities && typeof provider.capabilities === 'object' ? provider.capabilities : {}
      const codex = current.codex && typeof current.codex === 'object' ? current.codex : {}
      const models = codex.models && typeof codex.models === 'object' ? codex.models : {}
      result.provider = configStore.updateProviderCapabilities(provider.id, {
        ...current,
        codex: {
          ...codex,
          models: {
            ...models,
            [result.model]: {
              status: result.ok ? 'verified' : 'failed',
              checkedAt: new Date().toISOString(),
              credentialId: result.credentialId || provider.activeCredentialId || '',
              wireApi: 'responses',
              message: result.message || '',
              checks: result.checks || {},
            },
          },
        },
      })
    }
    return sendJson(res, 200, result)
  }

  if (url.pathname === '/api/routes' && req.method === 'POST') {
    return sendJson(res, 201, configStore.createRoute(await readJson(req)))
  }

  const routeRealTestMatch = url.pathname.match(/^\/api\/routes\/([^/]+)\/real-test$/)
  if (routeRealTestMatch && req.method === 'POST') {
    const config = configStore.get()
    const route = config.routes.find((item) => item.id === routeRealTestMatch[1])
    if (!route) throw new HttpError(404, 'route_not_found', 'Route not found.')
    if (!route.enabled) throw new HttpError(409, 'route_disabled', 'Enable this model route before running a route test.')
    const result = await realTestRoute(config, stateStore, {
      ...(await readJson(req)),
      model: route.virtualModel,
    }, config.service)
    recordRouteTestResult(result)
    return sendJson(res, 200, result)
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
  const diagnostic = testDiagnostic(provider, result)
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
      message: testFailureMessage(provider, result, 'Real test failed.'),
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
        error: result.ok ? null : testFailureMessage(provider, result, 'Real test failed.'),
        outcome: result.ok ? 'real_test_success' : 'real_test_failed',
        diagnostic,
      }],
      durationMs: latencyMs,
      outcome: result.ok ? 'real_test_success' : 'real_test_failed',
      stream: true,
      usage: result.ok ? result.usage : null,
      error: result.ok ? undefined : testFailureMessage(provider, result, 'Real test failed.'),
      diagnostics: diagnostic ? [diagnostic] : [],
    }, config.service.requestLogLimit)
  }
}

function recordProviderTestResult(provider, result) {
  const config = configStore.get()
  if (!config.service.logRequests) return

  const credential = resolveActiveCredential(provider)
  const latencyMs = Number(result.latencyMs) || 0
  const diagnostic = testDiagnostic(provider, result)
  stateStore.addRequestLog({
    testType: 'provider_test',
    method: 'TEST',
    path: '/v1/models',
    model: result.model || '',
    routedModel: '',
    providerId: provider.id,
    providerName: provider.name,
    credentialId: credential?.id || '',
    credentialLabel: credential?.label || '',
    status: result.status || 0,
    ok: Boolean(result.ok),
    attempts: [{
      providerId: provider.id,
      providerName: provider.name,
      credentialId: credential?.id || '',
      credentialLabel: credential?.label || '',
      model: result.model || '',
      status: result.status || 0,
      latencyMs,
      error: result.ok ? null : testFailureMessage(provider, result, 'Provider test failed.'),
      outcome: result.ok ? 'provider_test_success' : 'provider_test_failed',
      diagnostic,
    }],
    durationMs: latencyMs,
    outcome: result.ok ? 'provider_test_success' : 'provider_test_failed',
    stream: false,
    usage: null,
    error: result.ok ? undefined : testFailureMessage(provider, result, 'Provider test failed.'),
    diagnostics: diagnostic ? [diagnostic] : [],
  }, config.service.requestLogLimit)
}

function recordRouteTestResult(result) {
  const config = configStore.get()
  const attempts = Array.isArray(result?.attempts) ? result.attempts : []
  const publicAttempts = attempts.map((attempt) => {
    const provider = config.providers.find((item) => item.id === attempt.providerId)
    const diagnostic = attempt.ok || attempt.skipped
      ? null
      : routeTestDiagnostic(provider, attempt)
    const latencyMs = Number(attempt.latencyMs) || 0
    if (provider && !attempt.skipped) {
      if (attempt.ok) {
        stateStore.markSuccess(provider.id, { status: attempt.status || 200, latencyMs })
      } else {
        stateStore.markFailure(provider.id, {
          status: attempt.status || 0,
          message: attempt.message || 'Route test failed.',
          latencyMs,
          cooldownSeconds: 0,
        })
      }
    }
    return {
      providerId: attempt.providerId || '',
      providerName: attempt.providerName || '',
      credentialId: attempt.credentialId || '',
      credentialLabel: attempt.credentialLabel || '',
      model: attempt.model || '',
      status: attempt.status || 0,
      latencyMs,
      error: attempt.ok ? null : attempt.message || 'Route test failed.',
      outcome: attempt.ok ? 'route_test_success' : attempt.skipped ? 'route_test_skipped' : 'route_test_failed',
      diagnostic,
    }
  })

  if (!config.service.logRequests) return
  const finalProvider = config.providers.find((item) => item.id === result.providerId)
  const finalDiagnostic = result.ok
    ? null
    : routeTestDiagnostic(finalProvider, result)
  stateStore.addRequestLog({
    testType: 'route_test',
    method: 'TEST',
    path: '/v1/route-test',
    model: result.virtualModel || result.model || '',
    routedModel: result.routedModel || '',
    providerId: result.providerId || '',
    providerName: result.providerName || '',
    credentialId: result.credentialId || '',
    credentialLabel: result.credentialLabel || '',
    status: result.status || 0,
    ok: Boolean(result.ok),
    attempts: publicAttempts,
    durationMs: Number(result.latencyMs) || 0,
    outcome: result.ok ? 'route_test_success' : 'route_test_failed',
    stream: false,
    usage: result.ok ? result.usage : null,
    error: result.ok ? undefined : result.message || 'Route test failed.',
    diagnostics: [...publicAttempts.map((attempt) => attempt.diagnostic), finalDiagnostic].filter(Boolean),
  }, config.service.requestLogLimit)
}

function routeTestDiagnostic(provider, result) {
  if (result?.reason === 'no_credential') {
    return describeRoutingSkip(provider || { id: '', name: result.providerName || '未命名线路' }, 'no_enabled_key', result.model || '')
  }
  return describeUpstreamFailure(
    result?.status,
    result?.message || 'Route test failed.',
    result?.reason || 'upstream_error',
    { timedOut: result?.reason === 'local_timeout' },
  )
}

function testDiagnostic(provider, result) {
  if (!result || result.ok) return null
  if (result.reason === 'no_credential') {
    return describeRoutingSkip(provider, 'no_enabled_key', result.model || '')
  }

  const diagnostic = describeUpstreamFailure(
    result.status,
    testFailureMessage(provider, result, 'Upstream test failed.'),
    result.reason || 'upstream_error',
    { timedOut: result.reason === 'local_timeout' },
  )
  return {
    ...diagnostic,
    providerId: provider.id,
    providerName: provider.name,
    model: result.model || '',
  }
}

function testFailureMessage(provider, result, fallback) {
  return redactSecretText(result?.message || fallback, resolveActiveKey(provider))
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
    runtimeMeta: runtimeMeta(),
  }
}

function runtimeSummaryState() {
  const config = configStore.get()
  return {
    ...stateStore.getSummary(),
    outbound: currentOutboundRuntime(config.service),
    runtimeMeta: runtimeMeta(),
  }
}

function runtimeMeta() {
  const backendSourceUpdatedAtMs = latestBackendSourceUpdatedAt()
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    serverStartedAt: SERVER_STARTED_AT,
    backendSourceUpdatedAt: backendSourceUpdatedAtMs
      ? new Date(backendSourceUpdatedAtMs).toISOString()
      : null,
    restartRequired: backendSourceUpdatedAtMs > SERVER_STARTED_AT_MS,
  }
}

function latestBackendSourceUpdatedAt() {
  const files = [join(rootDir, 'scripts', 'launch-server.mjs')]
  try {
    for (const entry of readdirSync(join(rootDir, 'src'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(join(rootDir, 'src', entry.name))
    }
  } catch {
    return 0
  }

  let latest = 0
  for (const filePath of files) {
    try {
      latest = Math.max(latest, statSync(filePath).mtimeMs)
    } catch {
      // A source file may be replaced atomically while this check is running.
    }
  }
  return latest
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
