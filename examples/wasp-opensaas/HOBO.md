---
type: Reference
title: "Wasp OpenSaaS on HoBo"
description: "Real wasp-lang/open-saas via @hobo/wasp waspApp(root) + Bindle deps from Open SaaS docs."
tags: [hobo, examples, wasp, opensaas]
---

# Wasp OpenSaaS (HoBo packaging path)

Real [Open SaaS](https://docs.opensaas.sh/) from
[wasp-lang/open-saas](https://github.com/wasp-lang/open-saas) (`wasp new -t saas`).

## Bindle

```ts
import { bindle } from "@hobo/bindles";
import { waspApp } from "@hobo/wasp";

export default bindle((b) => {
  const db = b.container({
    image: "postgres:16-alpine",
    endpoints: { postgres: { port: 5432 } },
  }); // or b.external() for BYO DATABASE_URL
  const web = b.web(waspApp("examples/wasp-opensaas/app")).dependsOn(db);
  return { db, web };
});
```

Ship **runs `wasp` in `root`** (build / deploy railway / wrangler). Optional SaaS
keys (Stripe, S3, SendGrid, …) map to `b.external` / camp connectors —
`discoverWaspEnv(root)` reads `.env.server.example` per
[Deploying](https://docs.opensaas.sh/guides/deploying/).

General deploy env (docs): `DATABASE_URL`, `JWT_SECRET`, `WASP_WEB_CLIENT_URL`,
`WASP_SERVER_URL`.

## Examples Temporary (anon)

Bindle `db` (`postgres:16-alpine` locally) is realized on Cloudflare Temporary
yards via **Neon Claimable Postgres** (`POST https://neon.new/api/v1/database`
with **no Authorization** — 72h TTL, claim later). Zero project API keys.

| Piece | Anon Temporary host |
|---|---|
| `db` | Neon Claimable (`POST neon.new/api/v1/database`) |
| Wasp server | **Host chain:** OpenPouch HTTP Instant Lane (one-shot) → **Clawdship** Docker competitor (one-shot) → Cloudflare Temporary Worker + Neon HTTP shim (`/health`, `/db/ping`) |
| Web client | Cloudflare Temporary Pages (`wrangler deploy --temporary`) |

| Env | Notes |
|---|---|
| (default) | Live Neon + auto host chain (`HOBO_OPENSAAS_SERVER_HOST=auto`) |
| `HOBO_OPENSAAS_SERVER_HOST=cloudflare` | Skip competitors; CF Temporary Neon shim only |
| `HOBO_OPENSAAS_SERVER_HOST=openpouch` | OpenPouch only (no fallback; still one-shot) |
| `HOBO_OPENSAAS_SERVER_HOST=clawdship` | Clawdship only (OpenPouch competitor; still one-shot) |
| `HOBO_OPENPOUCH_TRANSPORT=http\|cli` | Default `http` Instant Lane; `cli` = `npx openpouch` |
| `HOBO_OPENSAAS_DB_MOCK=1` | CI mock DATABASE_URL |
| `HOBO_OPENSAAS_SERVER_MOCK=1` | CI mock server URL |

Per-host 429 writes a **6h cooldown** under `$TMPDIR/hobo-anon-host-cooldown/`
(plus legacy `$TMPDIR/hobo-openpouch-cooldown.json`) so Examples never hammer free
anon quota. Competitor matrix: [`docs/competitors/anon-container-hosts.md`](../../docs/competitors/anon-container-hosts.md).
CF last resort is a Neon-backed Worker shim, not a full Express/Prisma Wasp process.

Local yards still use the Postgres OCI image via compose/bridge.

One-shot e2e: `node --import tsx site/scripts/retry-opensaas-e2e.mts`
(validate: `site/scripts/validate-opensaas-temporary-e2e.mts`).

## Local

1. Docs: `wasp start db` · `wasp db migrate-dev` · `wasp start` (ports 3000/3001)
2. Examples: Pool stations → Ship OpenSaaS; bridge compose realizes Postgres OCI + wasp build artifacts

Compose `server`/`client` services = packaging of the Wasp `web` Kit, not Bindle resources.
