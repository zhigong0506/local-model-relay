import http from 'node:http'
import { spawn } from 'node:child_process'
import {
  parseWindowsProxyServer,
  resolveProviderOutboundProxy,
  resolveOutboundProxyPlan,
} from '../src/outbound-proxy.mjs'

const proxyHits = []
const connectHits = []
const directHits = []
const proxy = await startProxy()
const direct = await startDirectServer()

try {
  assertEqual(parseWindowsProxyServer('127.0.0.1:7897'), 'http://127.0.0.1:7897/', 'plain system proxy')
  assertEqual(
    parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7897'),
    'http://127.0.0.1:7897/',
    'split protocol system proxy',
  )

  const proxyUrl = serverBaseUrl(proxy)
  const plan = resolveOutboundProxyPlan(
    { outboundProxyMode: 'custom', outboundProxyUrl: proxyUrl },
    process.env,
  )
  assertEqual(plan.proxyUrl, `${proxyUrl}/`, 'global custom proxy resolved')
  assertEqual(plan.useEnvProxy, false, 'runtime proxy no longer needs node env proxy flag')
  assertEqual(plan.env.NO_PROXY, undefined, 'runtime proxy does not need process-wide NO_PROXY')

  const inherited = resolveProviderOutboundProxy(
    { outboundProxyMode: 'inherit' },
    { outboundProxyMode: 'custom', outboundProxyUrl: proxyUrl },
  )
  const forcedDirect = resolveProviderOutboundProxy(
    { outboundProxyMode: 'direct' },
    { outboundProxyMode: 'custom', outboundProxyUrl: proxyUrl },
  )
  const forcedCustom = resolveProviderOutboundProxy(
    { outboundProxyMode: 'custom', outboundProxyUrl: proxyUrl },
    { outboundProxyMode: 'direct' },
  )
  assertEqual(inherited.proxyUrl, `${proxyUrl}/`, 'provider inherit proxy')
  assertEqual(forcedDirect.proxyUrl, '', 'provider forced direct')
  assertEqual(forcedCustom.proxyUrl, `${proxyUrl}/`, 'provider forced custom proxy')

  const result = await runNode([
    ...plan.nodeArgs,
    '--input-type=module',
    '--eval',
    `
      const { upstreamFetch } = await import('./src/upstream-fetch.mjs')
      const proxied = await upstreamFetch('http://proxy-check.invalid/v1/models', { proxyUrl: '${proxyUrl}' }).then((r) => r.json())
      let httpsErrored = false
      try {
        await upstreamFetch('https://proxy-check.invalid/v1/models', { proxyUrl: '${proxyUrl}' })
      } catch {
        httpsErrored = true
      }
      const direct = await upstreamFetch('http://127.0.0.1:${direct.address().port}/ping', { proxyUrl: '${proxyUrl}' }).then((r) => r.text())
      console.log(JSON.stringify({ proxied, httpsErrored, direct }))
    `,
  ], plan.env)

  const childReport = JSON.parse(result.stdout.trim())
  const report = {
    ok: proxyHits.length === 1 &&
      connectHits.length === 1 &&
      directHits.length === 1 &&
      childReport.proxied.ok === true &&
      childReport.httpsErrored === true &&
      childReport.direct === 'DIRECT_OK',
    providerResolution: {
      inherited: inherited.effectiveMode,
      forcedDirect: forcedDirect.effectiveMode,
      forcedCustom: forcedCustom.effectiveMode,
    },
    proxyHits,
    connectHits,
    directHits,
    childReport,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  await closeServer(proxy)
  await closeServer(direct)
}

function startProxy() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    proxyHits.push({ method: req.method, url: req.url, bodyBytes: Buffer.byteLength(raw) })
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, via: 'mock-proxy', url: req.url }))
  })
  server.on('connect', (req, socket) => {
    connectHits.push({ method: 'CONNECT', url: req.url })
    socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })
  return listen(server)
}

function startDirectServer() {
  const server = http.createServer((req, res) => {
    directHits.push({ method: req.method, url: req.url })
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('DIRECT_OK')
  })
  return listen(server)
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

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`child exited ${code}: ${stderr || stdout}`))
      }
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}
