import assert from 'node:assert/strict'
import { describeRoutingSkip, describeUpstreamFailure, redactSecretText } from '../src/upstream-diagnostics.mjs'

const expectedCodes = new Map([
  [401, 'upstream_auth_failed'],
  [402, 'upstream_quota_exhausted'],
  [403, 'upstream_permission_denied'],
  [408, 'upstream_request_timeout'],
  [409, 'upstream_request_conflict'],
  [413, 'upstream_payload_too_large'],
  [425, 'upstream_overloaded'],
  [429, 'upstream_rate_limited'],
  [500, 'upstream_internal_error'],
  [502, 'upstream_gateway_error'],
  [503, 'upstream_unavailable'],
  [504, 'upstream_gateway_timeout'],
  [520, 'upstream_web_server_unknown_error'],
  [521, 'upstream_web_server_down'],
  [522, 'upstream_origin_connection_timeout'],
  [523, 'upstream_origin_unreachable'],
  [524, 'upstream_origin_response_timeout'],
])

for (const [status, code] of expectedCodes) {
  const diagnostic = describeUpstreamFailure(status, `mock ${status}`)
  assert.equal(diagnostic.code, code)
  assert.equal(diagnostic.status, status)
  assert.ok(diagnostic.title)
  assert.ok(diagnostic.suggestion)
}

const network = describeUpstreamFailure(0, 'fetch failed')
assert.equal(network.code, 'network_connection_failed')
const timeout = describeUpstreamFailure(0, 'operation aborted', 'local_timeout')
assert.equal(timeout.code, 'network_timeout')

const payload = describeUpstreamFailure(200, 'soft completion failure', 'upstream_payload_failed')
assert.equal(payload.code, 'upstream_payload_error')
assert.match(payload.message, /HTTP 200/)

const skipped = describeRoutingSkip(
  { id: 'provider-disabled', name: '停用 Key 线路' },
  'no_enabled_key',
  'gpt-test',
)
assert.equal(skipped.type, 'routing_skip')
assert.equal(skipped.code, 'no_enabled_key')
assert.equal(skipped.providerName, '停用 Key 线路')
assert.match(skipped.suggestion, /启用现有 Key/)
assert.equal(redactSecretText('upstream secret-key leaked', 'secret-key'), 'upstream [REDACTED] leaked')

console.log(JSON.stringify({
  ok: true,
  statusDiagnostics: expectedCodes.size,
  networkDiagnostic: network.code,
  payloadDiagnostic: payload.code,
  disabledKeyDiagnostic: skipped.code,
}, null, 2))
