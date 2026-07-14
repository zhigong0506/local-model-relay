import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ConfigStore } from '../src/config-store.mjs'
import {
  buildDiagnosticsEndpoint,
  buildDiagnosticsPrompt,
  parseDiagnosticsResponse,
  sanitizeDiagnosticLog,
} from '../src/diagnostics-llm.mjs'

assert.equal(buildDiagnosticsEndpoint('https://example.com'), 'https://example.com/v1/chat/completions')
assert.equal(buildDiagnosticsEndpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions')
assert.equal(buildDiagnosticsEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions')

const secret = 'sk-diagnostics-secret-123456'
const log = {
  method: 'POST',
  path: '/v1/responses?api_key=should-not-appear',
  model: 'diagnostics-model',
  providerName: '测试线路',
  error: `Bearer ${secret}; ${secret}; https://user:password@example.com`,
  requestBody: { messages: [{ content: 'private prompt' }] },
  headers: { authorization: `Bearer ${secret}` },
  attempts: [{ providerName: '测试线路', status: 502, error: secret }],
}
const sanitized = sanitizeDiagnosticLog(log)
const prompt = buildDiagnosticsPrompt(log)
assert.equal(sanitized.path, '/v1/responses')
assert.equal('requestBody' in sanitized, false)
assert.doesNotMatch(prompt, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.doesNotMatch(prompt, /private prompt/)
assert.match(prompt, /request-log/)

const structured = parseDiagnosticsResponse(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    summary: '上游网关异常，建议切换线路',
    category: '线路故障',
    confidence: 0.86,
    rootCause: '上游返回 502',
    evidence: ['HTTP 502'],
    failoverAssessment: '应故障转移',
    actions: [{ priority: '高', action: '检查备用线路' }],
    retryAdvice: '立即换线重试',
  }) } }],
}))
assert.equal(structured.format, 'json')
assert.equal(structured.category, '线路故障')
assert.equal(structured.confidence, 0.86)

const markdown = parseDiagnosticsResponse('```json\n{"summary":"无法确定","evidence":[]}\n```')
assert.equal(markdown.format, 'json')
assert.equal(markdown.summary, '无法确定')

const workDir = await mkdtemp(resolve(process.cwd(), 'work', 'diagnostics-config-'))
try {
  const store = new ConfigStore(resolve(workDir, 'config.json'))
  const initial = store.getPublic().service.diagnosticsLlm
  assert.equal(initial.enabled, false)
  assert.equal(initial.apiKeySet, false)
  assert.equal(initial.apiKey, '')

  store.updateService({
    diagnosticsLlm: {
      enabled: true,
      baseUrl: 'https://diagnostics.example/v1',
      model: 'diagnostics-model',
      apiKey: secret,
      timeoutMs: 45000,
    },
  })
  const configured = store.get()
  const publicConfigured = store.getPublic().service.diagnosticsLlm
  assert.equal(configured.service.diagnosticsLlm.apiKey, secret)
  assert.equal(publicConfigured.apiKey, '')
  assert.equal(publicConfigured.apiKeySet, true)
  assert.ok(publicConfigured.apiKeyMasked.includes('****'))

  store.updateService({ diagnosticsLlm: { enabled: true, baseUrl: 'https://diagnostics.example/v1', model: 'next-model', apiKey: '' } })
  assert.equal(store.get().service.diagnosticsLlm.apiKey, secret)
  store.updateService({ diagnosticsLlm: { enabled: false, clearApiKey: true } })
  assert.equal(store.get().service.diagnosticsLlm.apiKey, '')
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log(JSON.stringify({
  ok: true,
  endpointResolution: true,
  promptRedaction: true,
  structuredResponseParsing: true,
  publicKeyMasking: true,
  blankKeyPreservation: true,
  clearKeySupport: true,
}, null, 2))
