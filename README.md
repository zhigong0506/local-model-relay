# Local Model Relay

[中文说明](README.zh-CN.md)

Local Model Relay is a zero-build local control panel and OpenAI-compatible proxy for personal model-provider failover.

It lets you keep multiple upstream providers behind one local `/v1` endpoint, manage provider priority from a browser UI, define per-model routes, and automatically fail over when an upstream returns retryable errors such as `401`, `403`, `429`, `500`, `502`, `503`, or `504`.

## Features

- Local admin UI at `http://127.0.0.1:25818/admin`
- OpenAI-compatible local API at `http://127.0.0.1:25818/v1`
- Provider management with priorities, cooldowns, timeouts, credentials, and model lists
- Model routes that follow provider priority and auto-add matching providers
- Chat Completions and Responses protocol bridging
- Request logs, usage stats, dashboard charts, CSV export, and local usage estimates
- Deterministic failover and usage-estimate regression tests
- No build step, no npm dependencies, no external database

## Quick Start

```powershell
node src\server.mjs
```

Then open:

```text
http://127.0.0.1:25818/admin
```

Default local API settings:

```text
base_url = http://127.0.0.1:25818/v1
api_key  = local-relay
```

## Configuration

Runtime configuration is stored in `data/config.json`, and runtime state is stored in `data/state.json`.

These files are intentionally ignored by git because they may contain API keys, provider URLs, local usage records, or other private data.

Use `data/config.example.json` as a safe empty template.

## Tests

```powershell
npm run check
npm run test:failover
npm run test:usage-estimate
```

The e2e tests create temporary local mock providers and routes, call the real local relay endpoint, and clean up after themselves.

## Security Notes

- Do not commit `data/config.json` or `data/state.json`.
- Do not export and publish configs with secrets.
- API keys are stored locally in plain JSON by design for simplicity. Use this as a personal local tool unless you add encryption or a secret store.

## Design References

- aliyun-model-proxy style local port workflow
- sub2api style provider and usage concepts
- cc-switch style local switch and control-panel behavior
