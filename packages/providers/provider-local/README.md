# @hobo/provider-local

Definitions for the localhost Yard. This package declares
`ResourceDefinition` semantics (`hobo.resource-definition/vNext`) for the
seeded `yard:local` products that have a real engine in
`@hobo/runtime-local`, so a composed local deploy can *select* local
products with no cloud account, key, or call in reach.

**Local L2 definitions: 4/9 seed products** (6/11 seed profile rows).

The denominator is the localhost seed in `@hobo/yards`
(`seedLocalhostYard`, ADR-0157) with every host capability present: nine
distinct `local:*` products over eleven profile rows. The
`first-party-catalog.test.ts` suite in `@hobo/hobo` derives both sides from the
seed itself — claimed products plus `LOCAL_ENGINE_GAPS` must equal the seed
exactly.

## Claimed (engine traced in `@hobo/runtime-local`, 2026-11-08)

| Definition | Seed product | Profiles | Engine |
|---|---|---|---|
| `local.node-http-server/v1` | `local:node-http-server` | `api.http/v1`, `webhook.inbound-http/v1` | `createRuntimeLocalComponentHost` — `handleHttp` over the WASI HTTP incoming handler |
| `local.sqlite-file/v1` | `local:sqlite-file` | `data.sqlite/v1`, `data.relational/v1` | `createRuntimeLocalEventStore` over `SqliteJournal` + the `@hobo/storage-sqlite` Node driver |
| `local.in-memory-queue/v1` | `local:in-memory-queue` | `queue.at-least-once/v1` | `createLocalQueue` — leased delivery, idempotent enqueue, in-memory |
| `local.in-process-worker/v1` | `local:in-process-worker` | `service.worker/v1` | `createLocalRuntimeHost` — in-process fetch handlers, no OS sandbox |

## Not claimed (seed products with no local engine)

`local:filesystem-bucket`, `local:in-memory-kv`,
`local:in-memory-secret-locator`, `local:in-memory-topic`, and
`local:static-file-server` are exported as `LOCAL_ENGINE_GAPS`, each naming
the engine that would have to exist in `@hobo/runtime-local`. Selection over
this catalog returns no winner for their profiles — refused, never silently
substituted. The seed's own unavailable profiles
(`secret-ref.dynamic-resolution/v1`, `topic.durable-log/v1`) are likewise
never claimed.

## Honest non-claims

- **Definitions only.** No engine, driver, or apply loop lives here; the
  single local engine owner is `@hobo/runtime-local`. `executorRef` values
  name those engines.
- **Not L2-live.** Nothing here ran the six lifecycle cases against real
  local processes. Conformance refs end `@engine-traced@2026-11-08` and the
  shipped constants carry `conformance: "unknown"`,
  `evidenceSignatureValid: false`, and no evidence expiry — station-local
  evidence is injected by a composition that verified it, through
  `createLocalDefinitions(overrides)`. Until then selection refuses these
  products, which is the point.
- **No claim ceremony, no `replace`.** The station operator already owns
  local resources (`claimActionCount: 0`); a stack replaces by
  delete+create. No secret material is minted anywhere in this package.
- **Fidelity is stated, not smoothed over.** The queue is in-memory
  (`persistent: false`, data discarded on restart); the worker runs
  in-process handlers with no sandbox boundary; the SQLite product's typed
  data client is a later layer's work, so it produces no binding profiles.

Physical names are deterministic: `deterministicLocalResourceName` derives
`hobo-local--<product>--<logical>` purely from its inputs and refuses
path-shaped logical ids rather than sanitizing them into a different name.
