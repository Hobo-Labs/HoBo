# HoBo Cloudflare CORS relay (Temporary Accounts)

Browser entry for stamping Environment Stations **on static hosts** (GitHub
Pages). Fixes CORS: browsers cannot read `api.cloudflare.com` Temporary Accounts
responses, so this Worker runs Temporary Accounts **server-side** and returns
only `stationUrl` + `claimUrl` (never temporary `apiToken`).

**Local website:** prefer same-origin `astro dev` middleware
(`POST /HoBo/api/cf-temp/station`) — no external relay required.

## Auth model

**Temporary Accounts only.** Zero `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.

```bash
# From repo root — unauthenticated Temporary Accounts REST
pnpm exec tsx scripts/bootstrap-cf-cors-relay.mts
```

Prints `relayUrl` + `claimUrl`. Set Examples `PUBLIC_HOBO_STATION_BROKER_URL` /
`?stationBroker=` to `relayUrl`. Open `claimUrl` in a browser to keep the relay
past ~60m (Cloudflare claim — not an API token in the repo).

Agents/CLI alternative: `wrangler deploy --temporary` while **logged out**,
using `CORS_RELAY_WORKER_MODULE` from `@hobo/provider-cloudflare`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Liveness |
| `POST` | `/station` | Upload Environment Station onto the bootstrap Temporary Account |
| `OPTIONS` | `*` | CORS preflight for `*.github.io` / localhost |

Temporary Workers cannot nest Temporary Accounts (`worker_subrequest_blocked`).
Bootstrap materializes `TEMP_ACCOUNT_ID` / `TEMP_API_TOKEN` / `CLAIM_URL` into the
relay module so browser `POST /station` uploads Environment Stations onto that
same account via Workers Scripts API. Response never includes `apiToken`.

If Cloudflare returns edge error **1042** on `/station`, Temporary Workers are
blocked from managing sibling Workers Scripts on that account — use local
same-origin `/api/cf-temp`, open the `claimUrl`, or provision stations with
`provisionTemporaryEnvironmentStation` / `wrangler deploy --temporary` from an
agent (still zero permanent secrets).

## Limits

- Cloudflare temporary-account rate limits.
- Unclaimed relay ~60m TTL; claim for durability.
- Station bootstrap only — no Bindle / OpenSaaS apps.
