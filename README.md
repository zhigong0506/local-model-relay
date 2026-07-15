# Local Model Relay

[简体中文](README.zh-CN.md)

[![Node.js CI](https://github.com/zhigong0506/local-model-relay/actions/workflows/node.js.yml/badge.svg)](https://github.com/zhigong0506/local-model-relay/actions/workflows/node.js.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Local Model Relay is a zero-build, local OpenAI-compatible relay for people who
use multiple upstream API providers. It places provider priorities, per-model
routes, automatic failover, tests, request records, and Token usage behind one
browser control panel and one local `/v1` endpoint.

It is a personal desktop tool, not a multi-user gateway or billing platform.

## Highlights

- Provider priority, credentials, supported models, timeout, cooldown, and
  direct/system/custom proxy settings
- Virtual model routes that automatically follow provider priority
- Chat Completions and Responses request/response bridging
- Same-request failover for retryable HTTP status codes and stream failures
- Codex-compatible Responses text streams, function calls, tool results, and
  reconnect circuit breaking
- Provider-isolated reasoning fallback from `max` to `xhigh` only when the
  current upstream explicitly rejects `max`; later providers still receive the
  original `max` request
- Quick connectivity tests, model-aware real tests, and ad-hoc endpoint speed tests
- Searchable model pickers for large speed-test and real-test model lists
- Actionable request diagnostics for disabled keys, retry skips, common upstream
  failures, and HTTP 200 error payloads, with masked credential references
- Request records, pagination, date filters, Token charts, cache-Token diagnostics,
  system-aware light/dark themes, and compact model/provider share charts
- Configuration import/export with masked-secret export by default
- No runtime dependencies, build step, or external database

### External radar notice

The Radar tab lazily embeds
[Codex Reset Radar](https://codex-reset-radar.pages.dev/) in an iframe. All
external content, data, and branding belong to the original site. This project
does not scrape, modify, or redistribute that data; the embed is provided only
as a non-commercial local shortcut and does not imply an official partnership.

You can also visit the site owner's project
[Deng](https://deng.codexradar.com/). If the site owner would like the embed
removed, please contact the maintainers through
[GitHub Issues](https://github.com/zhigong0506/local-model-relay/issues).

## Requirements

- Node.js 20 or newer
- Git only when installing with `git clone`

No `npm install` step is required.

## Install

```powershell
git clone https://github.com/zhigong0506/local-model-relay.git
cd local-model-relay
npm start
```

Open `http://127.0.0.1:25818/admin` and add your first provider. The local API
is available at `http://127.0.0.1:25818/v1`.

On Windows, create desktop shortcuts after cloning:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

The script resolves the current clone directory automatically. You can also
double-click `open-control-panel.vbs` without creating shortcuts.

## First Run

1. Open the **Providers** tab and add a Base URL and API key.
2. Select the upstream wire protocol: Chat Completions, Responses, or auto.
3. Run the quick test and optionally save the discovered models.
4. Run a real test with one of the saved models.
5. Add or review the automatically synchronized model route.
6. Point your client to the local endpoint.

Default local client settings:

```text
base_url = http://127.0.0.1:25818/v1
api_key  = local-relay
```

Change the local API key in **Settings** before using the relay on a shared
computer.

## Codex Configuration

Add a custom provider to `~/.codex/config.toml` (Windows:
`%USERPROFILE%\.codex\config.toml`):

```toml
model_provider = "local_model_relay"
model = "your-route-model"

[model_providers.local_model_relay]
name = "Local Model Relay"
base_url = "http://127.0.0.1:25818/v1"
wire_api = "responses"
env_key = "LOCAL_RELAY_API_KEY"
requires_openai_auth = false
```

Set the matching environment variable before starting Codex:

```powershell
$env:LOCAL_RELAY_API_KEY = "local-relay"
```

`env_key` is the custom provider's bearer-token environment variable; keeping
`requires_openai_auth = false` avoids substituting Codex account credentials.
See the [official Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json).

### Codex failover behavior

- Errors received before meaningful stream output are retried on the next
  provider inside the same client request.
- Stream-level `response.failed`/`error` events, incomplete prefaces, and idle
  streams can therefore switch providers without asking the user to type
  "continue".
- Once meaningful output has reached Codex, responses from two providers are
  never spliced together. The failed provider is cooled down and Codex's next
  automatic reconnect skips it.

## Data and Privacy

Runtime files are created locally:

```text
data/config.json   provider settings and API keys
data/state.json    health state, request records, and usage totals
logs/              background launcher logs
work/              temporary compatibility-test data
```

These paths are ignored by Git. API keys are stored in plain JSON by design.
Exported configurations are masked unless the user explicitly chooses to
include secrets.

Keep the listener on `127.0.0.1`. Management API calls are restricted to local
loopback clients, but this project is not hardened as an internet-facing service.

## Update and Stop

```powershell
git pull --ff-only
npm start
```

Stop a foreground process with `Ctrl+C`. On Windows, use `stop.bat` or the stop
shortcut.

## Tests

```powershell
npm run test:all
```

The suite covers status-code failover, HTTP 200 error-payload rejection,
long-task quota exhaustion failover, stream failure and idle-stream failover,
Codex text/tool compatibility, reconnect circuit breaking, sticky routing,
proxy behavior, TLS socket-error protection, disabled-key routing, actionable
diagnostics, cache fields, usage estimates, theme/chart behavior, and real-test
model selection.
E2E tests run on random local ports with temporary data directories, so they do
not alter the user's running providers, routes, logs, or usage totals.

## Limitations

- Upstream compatibility still depends on how closely a provider follows the
  OpenAI Chat Completions or Responses formats.
- Cache Token values can only be recorded when the upstream reports them.
- This project does not provide users, permissions, billing, payments, or
  credential encryption.

## License

[MIT](LICENSE)
