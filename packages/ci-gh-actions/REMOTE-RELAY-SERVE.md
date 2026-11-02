# Remote CI relay (`hobo ci serve` and container deploy)

Use a dedicated relay partition for shared team environments, CD, and
production-style CI. The same process backs **`hobo ci serve`** in a checkout
and **`node dist/main.js`** in the [`deploy/Dockerfile`](deploy/Dockerfile);
both read the `HOBO_CI_*` environment described in
[`deploy/README.md`](deploy/README.md).

## Public origin vs listen address

GitHub webhooks and runner callbacks must target the **public HTTPS origin**
(`relayOrigin` in `.hobo/ci.json` for the selected `--environment`). The relay
process listens on **`--host`** / **`--port`** (or `HOBO_CI_HOST` /
`HOBO_CI_PORT`), which can differ when TLS terminates at a reverse proxy.

```sh
hobo ci serve \
  --environment production \
  --host 0.0.0.0 --port 8787 \
  --origin https://ci.example.com \
  --trust-proxy
```

`--origin` must match the environment’s `relayOrigin` (also accepted:
`--base-url`, `--url`, `--endpoint`). A mismatch is rejected before bind.

## Secrets (never logged)

| Variable | Purpose |
| --- | --- |
| `HOBO_CI_GITHUB_APP_ID` | GitHub App id |
| `HOBO_CI_GITHUB_APP_KEY_FILE` | App private key PEM |
| `HOBO_CI_WEBHOOK_SECRET` / `_FILE` | GitHub webhook HMAC |
| `HOBO_CI_CONTROL_TOKENS_FILE` | Account bearer token digests |
| `HOBO_CI_INGRESS_FORWARD_SECRET` / `_FILE` | HMAC for ingress → relay forwards |

Remote binds require real App credentials; loopback dev may synthesize keys when
files are absent.

## Reverse proxy and ingress forwarding

**Direct GitHub delivery:** point the App webhook URL at
`https://ci.example.com/engines/gh-actions/github/webhooks` (legacy
`/github/webhooks` still works when `HOBO_CI_LEGACY_ROOT_PATHS` is unset).

**Central ingress:** run the stateless
[`createWebhookIngressHandler`](src/webhook-ingress.ts) in front of multiple
relays. It verifies the GitHub signature, loads `.hobo/ci.json` at the event
commit, selects the environment, and POSTs to the relay with
`X-Hobo-Ingress-Forward: sha256=…` over the raw body. The relay verifies that
HMAC with `HOBO_CI_INGRESS_FORWARD_SECRET` and skips the GitHub signature on
that path.

Set **`--trust-proxy`** (or `HOBO_CI_TRUST_PROXY=1`) when the relay sits behind
a TLS terminator that sets `X-Forwarded-Proto`. If the header is present and not
`https`, webhook intake returns 403.

## Health, readiness, shutdown

| Path | Meaning |
| --- | --- |
| `GET /healthz` | Process liveness |
| `GET /readyz` | Partition readiness (per-engine map when stubs are enabled) |

SIGINT/SIGTERM start a drain: readiness fails, in-flight HTTP completes within
the configured timeout, SQLite closes, partition lock releases.

Structured JSON lines are written on serve start (`serve.starting`, `serve.ready`)
and from the relay service (`service.started`, `service.draining`, …).

## Container image

Build and run as documented in [`deploy/README.md`](deploy/README.md). Set
`HOBO_CI_PUBLIC_URL` to the same origin as `--origin`, mount secrets read-only,
and route your ingress or Caddy/nginx reverse proxy to the container’s listen
port. Add `HOBO_CI_INGRESS_FORWARD_SECRET` when using a shared webhook ingress.
