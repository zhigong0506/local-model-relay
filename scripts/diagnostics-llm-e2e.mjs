import assert from 'node:assert/strict'
import http from 'node:http'

const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'
const diagnosticKey = 'diagnostic-e2e-key-should-not-leak'
const requestSecret = 'sk-request-secret-should-not-leak-123456'
const received = []
let upstream

try {
  upstream = await startMockLlm()
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
  await api('/api/service', {
    method: 'PATCH',
    body: {
      diagnosticsLlm: {
        enabled: true,
        baseUrl,
        apiKey: diagnosticKey,
        model: 'mock-diagnostics-model',
        timeoutMs: 10000,
      },
    },
  })

  const publicConfig = await api('/api/config')
  const publicLlm = publicConfig.service.diagnosticsLlm
  assert.equal(publicLlm.enabled, true)
  assert.equal(publicLlm.apiKey, '')
  assert.equal(publicLlm.apiKeySet, true)
  assert.doesNotMatch(JSON.stringify(publicLlm), new RegExp(diagnosticKey))

  const response = await api('/api/diagnostics/ai', {
    method: 'POST',
    body: {
      log: {
        time: new Date().toISOString(),
        method: 'POST',
        path: '/v1/responses?token=private',
        model: 'gpt-test',
        providerName: '测试线路',
        status: 502,
        ok: false,
        outcome: 'upstream_error',
        error: `Bearer ${requestSecret}; ${requestSecret}`,
        headers: { authorization: `Bearer ${requestSecret}` },
        requestBody: { messages: [{ content: 'private prompt must not be sent' }] },
        attempts: [{ providerName: '测试线路', status: 502, error: requestSecret }],
      },
    },
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.category, '线路故障')
  assert.equal(response.result.failoverAssessment, '应故障转移')
  assert.equal(received.length, 1)
  assert.equal(received[0].authorization, `Bearer ${diagnosticKey}`)
  assert.equal(received[0].body.model, 'mock-diagnostics-model')
  const serializedMessages = JSON.stringify(received[0].body.messages)
  assert.match(serializedMessages, /不要输出任何 API Key/)
  assert.doesNotMatch(serializedMessages, new RegExp(requestSecret))
  assert.doesNotMatch(serializedMessages, /private prompt must not be sent/)
  assert.doesNotMatch(serializedMessages, /requestBody/)

  const testResponse = await api('/api/diagnostics/ai/test', { method: 'POST' })
  assert.equal(testResponse.ok, true)
  assert.equal(testResponse.test, true)
  assert.equal(received.length, 2)

  console.log(JSON.stringify({
    ok: true,
    endpoint: '/v1/chat/completions',
    requestLogRedacted: true,
    apiKeyNotExposed: true,
    structuredDiagnosis: true,
    testEndpoint: true,
  }, null, 2))
} finally {
  if (upstream) await new Promise((resolve) => upstream.close(resolve))
}

function startMockLlm() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    received.push({
      authorization: String(req.headers.authorization || ''),
      url: req.url,
      body,
    })
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.statusCode = 200
    res.end(JSON.stringify({
      id: 'chatcmpl-diagnostics-e2e',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: '上游网关异常，建议故障转移',
            category: '线路故障',
            confidence: 0.94,
            rootCause: '尝试链中出现 HTTP 502，属于上游网关异常。',
            evidence: ['第一条尝试返回 HTTP 502', '本地记录为 upstream_error'],
            failoverAssessment: '应故障转移',
            actions: [{ priority: '高', action: '切换到下一条可用线路并检查原线路状态。' }],
            retryAdvice: '立即使用下一条线路重试。',
          }),
        },
      }],
    }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
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
