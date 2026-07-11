# Security Policy

## Intended deployment

Local Model Relay is designed for one person on one machine. Keep
`service.listenHost` set to `127.0.0.1`. Do not expose the admin panel or local
API directly to a LAN or the public internet.

API keys are stored as plain text in `data/config.json`. Protect the operating
system account that runs the relay, and do not sync the `data/`, `logs/`, or
`work/` directories to a public location.

## Reporting a vulnerability

Please open a GitHub security advisory for vulnerabilities. Do not include real
provider keys, exported private configurations, request logs, or signed URLs in
an issue, screenshot, reproduction repository, or pull request.

## Before sharing diagnostics

- Replace provider Base URLs when they identify a private service.
- Remove API keys and proxy credentials.
- Remove `data/config.json`, `data/state.json`, `logs/`, and `work/`.
- Prefer a minimal reproduction with local mock upstreams.
