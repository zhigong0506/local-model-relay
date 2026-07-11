# Changelog

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
