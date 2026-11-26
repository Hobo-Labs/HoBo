---
type: Reference
title: "Convex Swaghaus on HoBo"
description: "Real JamesCowling/swaghaus via @hobo/convex + WorkOS; anon Temporary Convex self-host currently fail-closed under zero project API keys."
tags: [hobo, examples, convex, swaghaus, workos]
---

# Convex Swaghaus (HoBo packaging path)

Vendored [JamesCowling/swaghaus](https://github.com/JamesCowling/swaghaus)
(MIT) — Vite + React + Convex + WorkOS AuthKit. Upstream: https://swaghaus.biz/

Bindle pins official OCI `ghcr.io/get-convex/convex-backend` (never
`hobo/convex-*`). Frontend still ships on Cloudflare Temporary Pages.

## Anon Temporary self-host status

Examples Temporary requires **zero project API keys**. Live probes rejected
every candidate host for running official Convex OCI/binary under that rule:

| Host | Verdict |
|---|---|
| Cloudflare Temporary + Containers | PoW OK; Containers apply **403** |
| Instanode | Vendor: **no anonymous container deployments** |
| OpenPouch anon | Node anon OK; cgroup **memory.max=256MiB**; official `convex-local-backend` ≈205MB → extract OOM-kills |
| ttl.sh | Registry only — does not run |
| E2B / SnapDeploy | Need API keys / signup — **forbidden** |
| APPISH | Free slots gate on login; anon crane push fails |

`provisionConvexBackendAnonymous` therefore **fails closed** on live and
returns a Temporary-shaped mock URL only when `HOBO_CONVEX_SWAGHAUS_MOCK=1`.

Escape hatches (not anon-zero-key): `HOBO_CONVEX_OCI_HOST=cloudflare`,
`HOBO_CONVEX_ALLOW_CLOUD=1`.

## Bindle

```ts
import { bindle } from "@hobo/bindles";
import { convexApp } from "@hobo/convex";

export default bindle((b) => {
  const backend = b.container({
    image: "ghcr.io/get-convex/convex-backend:latest",
    endpoints: {
      api: { port: 3210 },
      httpActions: { port: 3211 },
    },
  });
  const auth = b.external({
    endpoints: { workos: "https://api.workos.com" },
  });
  const web = b
    .web(convexApp("examples/convex-swaghaus"))
    .dependsOn(backend, auth);
  return { backend, auth, web };
});
```

## Examples ship

1. `provisionConvexBackendAnonymous` — mock Temporary URL, or live fail-closed matrix
2. `convex deploy` against that URL when a real backend exists
3. Vite client → Cloudflare Temporary Pages

| Need | Notes |
|---|---|
| Zero project deploy keys | No `E2B_API_KEY` / permanent CF token / OpenPouch account key |
| WorkOS | Fail-closed for AuthKit (app auth, not deploy) |
| `HOBO_CONVEX_SWAGHAUS_MOCK=1` | CI mock `*.anon.hobo.test` URL |
| `HOBO_CONVEX_OCI_HOST=cloudflare` | Opt into Temporary Containers (often 403) |
| `HOBO_CONVEX_ALLOW_CLOUD=1` | Opt-in Convex Cloud escape (not default) |

Laptop `127.0.0.1` self-host is ignored on remote-public yards.

## Local Yard only (Webernetes / Lakebed)

`docker compose` in this directory remains valid for **local** frontend yards only.

## Attribution

Copyright upstream authors; MIT license in this directory's `LICENSE`.
Naming Convex / WorkOS / Cloudflare is nominative fair use — no endorsement.
