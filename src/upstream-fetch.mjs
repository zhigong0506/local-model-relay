import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

export function upstreamFetch(url, init = {}) {
  const target = new URL(url)
  const proxyUrl = normalizeProxyUrl(init.proxyUrl)
  if (proxyUrl && !isLocalHostname(target.hostname)) return proxyFetch(target, proxyUrl, init)

  const client = target.protocol === 'https:' ? https : http
  const headers = toNodeHeaders(init.headers)
  if (!hasHeader(headers, 'accept-encoding')) {
    headers['accept-encoding'] = 'identity'
  }

  return new Promise((resolve, reject) => {
    const request = client.request(target, {
      method: init.method || 'GET',
      headers,
      signal: init.signal,
    }, (message) => {
      const responseHeaders = toWebHeaders(message.headers)
      const body = decodeBody(message, responseHeaders)
      resolve(new Response(Readable.toWeb(body), {
        status: message.statusCode || 502,
        statusText: message.statusMessage || '',
        headers: responseHeaders,
      }))
    })

    request.on('error', reject)
    if (init.body !== undefined && init.body !== null) {
      request.end(init.body)
    } else {
      request.end()
    }
  })
}

function proxyFetch(target, proxyUrl, init = {}) {
  if (target.protocol === 'http:') return httpProxyFetch(target, proxyUrl, init)
  if (target.protocol === 'https:') return httpsProxyFetch(target, proxyUrl, init)
  return Promise.reject(new TypeError(`Unsupported protocol: ${target.protocol}`))
}

function httpProxyFetch(target, proxyUrl, init = {}) {
  const client = proxyUrl.protocol === 'https:' ? https : http
  const headers = toNodeHeaders(init.headers)
  if (!hasHeader(headers, 'accept-encoding')) {
    headers['accept-encoding'] = 'identity'
  }

  const proxyHeaders = proxyAuthorizationHeaders(proxyUrl)

  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: proxyUrl.protocol,
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || defaultProxyPort(proxyUrl),
      method: init.method || 'GET',
      path: target.href,
      headers: {
        ...headers,
        ...proxyHeaders,
        host: target.host,
      },
      signal: init.signal,
    }, (message) => {
      resolveResponse(message, resolve)
    })

    request.on('error', reject)
    endRequest(request, init.body)
  })
}

function httpsProxyFetch(target, proxyUrl, init = {}) {
  const client = proxyUrl.protocol === 'https:' ? https : http
  const targetPort = target.port || '443'
  const proxyHeaders = proxyAuthorizationHeaders(proxyUrl)

  return new Promise((resolve, reject) => {
    let settled = false
    const resolveOnce = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const connect = client.request({
      protocol: proxyUrl.protocol,
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || defaultProxyPort(proxyUrl),
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: {
        ...proxyHeaders,
        host: `${target.hostname}:${targetPort}`,
      },
      signal: init.signal,
    })

    connect.once('connect', (response, socket) => {
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        protectSocketErrors(socket)
        socket.destroy()
        rejectOnce(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode || 0}`))
        return
      }

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname,
      })
      secureSocket.on('error', rejectOnce)
      secureSocket.once('close', () => secureSocket.off('error', rejectOnce))

      const headers = toNodeHeaders(init.headers)
      if (!hasHeader(headers, 'accept-encoding')) {
        headers['accept-encoding'] = 'identity'
      }

      const request = https.request(target, {
        method: init.method || 'GET',
        headers,
        createConnection: () => secureSocket,
        agent: false,
        signal: init.signal,
      }, (message) => {
        resolveResponse(message, resolveOnce)
      })

      request.on('error', rejectOnce)
      endRequest(request, init.body)
    })

    connect.on('error', rejectOnce)
    connect.end()
  })
}

function toNodeHeaders(headersInit = {}) {
  const headers = {}

  if (headersInit instanceof Headers) {
    for (const [name, value] of headersInit.entries()) {
      headers[name] = value
    }
    return headers
  }

  if (Array.isArray(headersInit)) {
    for (const [name, value] of headersInit) {
      headers[String(name)] = String(value)
    }
    return headers
  }

  for (const [name, value] of Object.entries(headersInit || {})) {
    if (value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }

  return headers
}

function toWebHeaders(headers) {
  const out = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out.set(name, Array.isArray(value) ? value.join(', ') : String(value))
  }
  return out
}

function resolveResponse(message, resolve) {
  const responseHeaders = toWebHeaders(message.headers)
  const body = decodeBody(message, responseHeaders)
  resolve(new Response(Readable.toWeb(body), {
    status: message.statusCode || 502,
    statusText: message.statusMessage || '',
    headers: responseHeaders,
  }))
}

function endRequest(request, body) {
  if (body !== undefined && body !== null) {
    request.end(body)
  } else {
    request.end()
  }
}

function protectSocketErrors(socket) {
  if (!socket || typeof socket.on !== 'function') return
  const ignoreError = () => {}
  socket.on('error', ignoreError)
  if (typeof socket.once === 'function' && typeof socket.off === 'function') {
    socket.once('close', () => socket.off('error', ignoreError))
  }
}

function normalizeProxyUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Only HTTP or HTTPS proxy URLs are supported for upstream proxying.')
  }
  return url
}

function defaultProxyPort(proxyUrl) {
  return proxyUrl.protocol === 'https:' ? '443' : '80'
}

function proxyAuthorizationHeaders(proxyUrl) {
  if (!proxyUrl.username) return {}
  const username = decodeURIComponent(proxyUrl.username)
  const password = decodeURIComponent(proxyUrl.password || '')
  return {
    'proxy-authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  }
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]'
}

function decodeBody(message, headers) {
  const encoding = (headers.get('content-encoding') || '').toLowerCase().trim()
  if (!encoding || encoding === 'identity') return message

  headers.delete('content-encoding')
  headers.delete('content-length')

  if (encoding === 'gzip' || encoding === 'x-gzip') return message.pipe(createGunzip())
  if (encoding === 'deflate') return message.pipe(createInflate())
  if (encoding === 'br') return message.pipe(createBrotliDecompress())
  return message
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}
