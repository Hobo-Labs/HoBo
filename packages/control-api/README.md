# `@hobo/control-api`

Local-first control-plane HTTP + SSE adapter for the HoBo Yard game UI.

```ts
import { createControlApiServer } from "@hobo/control-api";

const server = await createControlApiServer({
  hoboHome: process.env.HOBO_HOME ?? `${process.env.HOME}/.hobo`,
  port: 8790,
});
// GET http://127.0.0.1:8790/v1/yard/snapshot
// GET http://127.0.0.1:8790/v1/yard/stream  (SSE)
```

CLI: `hobo serve control` (when wired) or programmatic start above.

PACT: `contracts/pacts/control-api.pact.json`

## CD surface under `/v1/cd/`

Pass `cd` to mount HoBo CD's read API, SSE fact stream and agent delivery
feed. The mount is typed structurally (`CdHttpMount`: `pathPrefix` plus
`handle(request, signal)`, the delivery-feed shape), so this package has no
build-time dependency on `@hobo/cd`; composition passes
`createCdControlApi(...)` from `@hobo/cd/service`:

```ts
const server = await createControlApiServer({
  hoboHome,
  cd: createCdControlApi({ store, tenant, now, cd, topology, service, telemetry }),
});
// GET  /v1/cd/pipelines/shop, /v1/cd/camps?condition=READY, /v1/cd/stream (SSE) …
// POST /v1/cd/leases, GET /v1/cd/feed …   (agents, DPoP-authenticated by the feed)
```

The server passes method, path with query, lower-cased headers and the raw
body (≤ 8 MiB, else 413) through; streams async-iterable bodies chunk by
chunk; aborts the handler when the client disconnects; and merges the mount's
OpenAPI paths and schemas into `/v1/openapi.json`. Without `cd`, `/v1/cd/` is
a plain 404. Routes, envelopes, typed failures and the runbook:
[`packages/cd/src/service/README.md`](../cd/src/service/README.md). PACT:
`contracts/pacts/control-api-cd.pact.json`; envelope and view shapes: the
`Cd*` messages in `data-models/control_api.{proto,cue}`.

### Runbook

- **`/v1/cd/*` returns 404 `not-found` from the control API.** No `cd` mount
  was passed; start the server through `hobo serve cd` / composition.
- **SSE through a proxy stalls.** Responses are `text/event-stream` with
  `cache-control: no-cache, no-transform`; disable proxy buffering for
  `/v1/cd/stream` and `/v1/cd/feed`.
- **413 on agent observations.** The control API caps bodies at 8 MiB; the
  feed itself caps observations at 1 MiB, so a 413 here means a misbehaving
  client.
