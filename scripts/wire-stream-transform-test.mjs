import assert from 'node:assert/strict'
import { createWireStreamTransformer, WIRE_CHAT, WIRE_RESPONSES } from '../src/wire-api.mjs'

const encoder = new TextEncoder()

const responsesToChat = createWireStreamTransformer({
  transform: true,
  incomingApi: WIRE_CHAT,
  upstreamApi: WIRE_RESPONSES,
})

const created = `event: response.created\r\ndata: ${JSON.stringify({
  type: 'response.created',
  response: { id: 'resp_stream_transform', model: 'gpt-test' },
})}\r\n\r\n`
assert.deepEqual(responsesToChat.ingest(encoder.encode(created)), [])

const delta = Buffer.from(
  'event: response.output_text.delta\r\n' +
  'data: {"type":"response.output_text.delta","response_id":"resp_stream_transform",\r\n' +
  'data: "delta":"你"}\r\n\r\n',
  'utf8',
)
const unicodeStart = delta.indexOf(Buffer.from('你', 'utf8'))
assert.ok(unicodeStart > 0, 'unicode test byte was not found')
assert.deepEqual(responsesToChat.ingest(delta.subarray(0, unicodeStart + 1)), [])
const chatDelta = responsesToChat.ingest(delta.subarray(unicodeStart + 1))
assert.equal(chatDelta.length, 1)
assert.match(chatDelta[0], /"content":"你"/)
assert.doesNotMatch(chatDelta[0], /\[DONE\]/)

const completed = `event: response.completed\r\ndata: ${JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp_stream_transform',
    status: 'completed',
    model: 'gpt-test',
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  },
})}\r\n\r\n`
assert.deepEqual(responsesToChat.ingest(encoder.encode(completed)), [])
const chatFinish = responsesToChat.finish()
assert.equal(chatFinish.length, 2)
assert.match(chatFinish[0], /"finish_reason":"stop"/)
assert.match(chatFinish[0], /"total_tokens":7/)
assert.equal(chatFinish[1], 'data: [DONE]\n\n')
assert.equal(responsesToChat.responseId(), 'resp_stream_transform')

const chatToResponses = createWireStreamTransformer({
  transform: true,
  incomingApi: WIRE_RESPONSES,
  upstreamApi: WIRE_CHAT,
})
const chatChunk = `data: ${JSON.stringify({
  id: 'chatcmpl_stream_transform',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta: { content: 'incremental' }, finish_reason: null }],
})}\n\n`
const responsesDelta = chatToResponses.ingest(encoder.encode(chatChunk))
assert.ok(responsesDelta.some((item) => item.includes('event: response.output_text.delta')))
assert.ok(responsesDelta.some((item) => item.includes('"delta":"incremental"')))
const chatTerminal = `data: ${JSON.stringify({
  id: 'chatcmpl_stream_transform',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
})}\n\ndata: [DONE]\n\n`
assert.deepEqual(chatToResponses.ingest(encoder.encode(chatTerminal)), [])
const responsesFinish = chatToResponses.finish().join('')
assert.match(responsesFinish, /event: response.completed/)
assert.match(responsesFinish, /"status":"completed"/)
assert.match(responsesFinish, /"total_tokens":5/)

const failed = createWireStreamTransformer({
  transform: true,
  incomingApi: WIRE_CHAT,
  upstreamApi: WIRE_RESPONSES,
})
assert.throws(
  () => failed.ingest(encoder.encode(`event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: { status: 'failed', error: { message: 'quota exhausted' } },
  })}\n\n`)),
  (error) => error?.code === 'UPSTREAM_STREAM_FAILED' && /quota exhausted/.test(error.message),
)
assert.deepEqual(failed.finish(), [])

const incomplete = createWireStreamTransformer({
  transform: true,
  incomingApi: WIRE_CHAT,
  upstreamApi: WIRE_RESPONSES,
})
const incompleteOutput = incomplete.ingest(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({
  type: 'response.output_text.delta',
  response_id: 'resp_incomplete',
  delta: 'partial',
})}\n\n`)).join('')
const incompleteFinish = incomplete.finish().join('')
assert.match(incompleteOutput, /partial/)
assert.doesNotMatch(incompleteFinish, /\[DONE\]|"finish_reason":"stop"/)

console.log(JSON.stringify({
  ok: true,
  responsesToChatIncremental: true,
  chatToResponsesIncremental: true,
  failureIsTerminal: true,
  incompleteDoesNotForgeCompletion: true,
}, null, 2))
