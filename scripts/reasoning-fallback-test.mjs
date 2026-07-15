import assert from 'node:assert/strict'
import { buildReasoningFallback, requestedReasoningEffort } from '../src/reasoning-fallback.mjs'

const responsesBody = { model: 'test', reasoning: { effort: 'max', summary: 'auto' } }
const responsesFallback = buildReasoningFallback(responsesBody, {
  status: 503,
  message: '{"error":{"code":"codex_model_price_not_configured"}}',
})
assert.equal(responsesFallback?.body?.reasoning?.effort, 'xhigh')
assert.equal(responsesFallback?.body?.reasoning?.summary, 'auto')
assert.equal(responsesBody.reasoning.effort, 'max')

const chatBody = { model: 'test', reasoning_effort: 'max' }
const chatFallback = buildReasoningFallback(chatBody, {
  status: 400,
  message: 'reasoning effort max is not supported',
})
assert.equal(chatFallback?.body?.reasoning_effort, 'xhigh')
assert.equal(chatBody.reasoning_effort, 'max')

assert.equal(buildReasoningFallback(responsesBody, {
  status: 503,
  message: 'generic provider outage',
}), null)
assert.equal(buildReasoningFallback({ reasoning: { effort: 'xhigh' } }, {
  status: 400,
  message: 'reasoning effort max is not supported',
}), null)
assert.equal(requestedReasoningEffort({ reasoning_effort: 'MAX' }), 'max')

console.log(JSON.stringify({ ok: true }, null, 2))
