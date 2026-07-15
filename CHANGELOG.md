# Changelog

## Unreleased

- Added Codex OAuth account providers with browser login/import, token refresh,
  redacted public configuration, and account-level failover before switching to
  the next provider.
- Added session affinity for client session headers and `previous_response_id`,
  with automatic bypass when the bound provider cannot serve the model.
- Improved HTTPS-over-HTTP-proxy reliability by completing TLS through a
  managed CONNECT agent instead of handing an unfinished socket to requests.
- Expanded the Chinese project homepage with architecture, routing semantics,
  installation guidance, privacy boundaries, and a current comparison with
  CC Switch.
- Added a lazy-loaded Radar tab embedding Codex Reset Radar, with clear source
  attribution, a non-commercial notice, removal contact, and a link promoting
  the site owner's Deng project.
- Added provider-isolated reasoning fallback: an upstream that explicitly
  rejects `max` can retry once with `xhigh` without changing the original
  request or downgrading later providers that support `max`.
- Kept Codex request-header verification as a manual provider test only; it no
  longer filters or reorders normal relay traffic.
- Improved provider and model-route drag sorting with smoother motion and a
  reduced-motion fallback.
- Added regression coverage proving the request order remains
  `provider A: max -> xhigh`, then `provider B: max`.

## 0.4.0 - 2026-07-14

- Added provider-group management with OpenAI and DeepSeek defaults, group-aware
  provider editing, migration coverage, and group CRUD regression tests.
- Added route-level real testing with per-provider attempts, latency, and
  failover results, plus session-affinity and routing-state coverage.
- Added structured AI diagnostics configuration and redacted diagnostic tests.
- Added incremental stream transformation and runtime-state checks for Codex
  Responses compatibility.
- Updated the public configuration example to the current version 3 schema.

## 0.3.0 - 2026-07-12

- Added actionable per-request diagnostics for disabled or unavailable keys,
  routing skips, common upstream HTTP and network failures, and stream failures.
- Treat HTTP 200 responses containing upstream error payloads as failures across
  relay forwarding, provider tests, and speed tests, allowing safe failover.
- Added TLS and connect-socket error guards so late socket errors cannot crash
  the local relay process.
- Added light/dark theme support that follows the system by default and can be
  overridden manually, plus compact share charts with external legends.
- Added regression coverage for diagnostics, disabled-key routing, HTTP 200
  error payloads, socket protection, configuration boundaries, and theme/chart UI.

## 0.2.2 - 2026-07-11

- Replaced native model dropdowns with searchable in-app model pickers for
  speed tests and provider real tests, so large model lists can be filtered
  without browser `select` or `datalist` display limits.
- Added a UI regression check that verifies the searchable picker replaces the
  native controls.

## 0.2.1 - 2026-07-11

- Added a long-task quota-exhaustion regression test: a provider completes
  several streamed Responses turns, returns HTTP 402, then the same request
  falls through to a backup and later requests skip the cooling provider.

## 0.2.0 - 2026-07-11

- Added modern dashboard, request records, pagination, date-range usage charts,
  model/provider Token distribution, and cache Token diagnostics.
- Added Chat Completions and Responses routing, model-aware real tests, and a
  temporary endpoint speed-test tool.
- Added global and per-provider outbound proxy selection.
- Added locked or auto-advancing routing start points.
- Added same-request failover for retryable HTTP errors, stream-level failures,
  incomplete stream prefaces, and idle upstream streams.
- Added Codex-compatible Responses text/tool streaming and reconnect circuit
  breaking after repeated incomplete client reconnects.
- Moved end-to-end tests to isolated random ports and temporary data folders.
- Added loopback enforcement for management API calls.

## 0.1.0 - 2026-07-09

- Initial sanitized public release.
