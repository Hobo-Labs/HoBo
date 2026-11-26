---
layout: ../../layouts/Docs.astro
title: Session Replay
description: "Privacy-first Session Replay (Session Replay, ): default on every App Kit, dual fixtures, replay.* events, CLI, and naming split from event-log replay."
---

# Session Replay

**Session Replay** reconstructs user DOM/sessions (and Kit-level interactive capture) for debugging and support. It is **not** control-plane event-log replay and **not** auth `session.*`.

## Naming split (critical)

| Concept | Meaning | Family / surface |
|---|---|---|
| **Event-log replay** | Fold durable facts for projections/audit | EventStore / `hobo inspect` |
| **Auth session** | Login/refresh/revoke | `session.Started` / `Refreshed` / `Revoked` |
| **Session Replay** | DOM/session reconstruction | `replay.*` + Session Replay |
| **App Kit** | Bindle-declared app surface (`api`, `web`, `service`, …) | `hobo/bindles` `app kit kinds` |

Heavy rrweb streams **never** enter the control-plane event log — only content-addressed blob refs.

## Defaults

| Environment | Default |
|---|---|
| Local / dual fixtures / Station air-gap / every **App Kit** | **On** (zero Bindle config) |
| Production / staging | **Off** unless OpenFeature `hobo.session-replay` or sample rate |
| Kill switch | `HOBO_REPLAY=0` (or flag false) |

## Deep Bindle integration (App Kits)

Every **App Kit** receives a default platform annotation `session-replay` at construction — **not only** `web`:

| App Kit | Kind | Default Session Replay |
|---|---|---|
| API Kit | `api` | **On** |
| Web Kit | `web` | **On** |
| Service Kit | `service` | **On** |
| UI Kit | `ui` | **On** |
| Realtime Kit | `websocket` | **On** |
| Job Kit | `job` | **On** |
| Component Kit | `wasm-component` | **On** |

**Infra Kits** (`kv`, `bucket`, `queue`, `topic`, `secret`, `data`, …) are **not** entrypoint hosts — no default Session Replay.

Local Yard / `hobo dev` wraps every **HTTP App Kit** (`api`, `web`, `service`, `ui`) so HTML gets a privacy-first bootstrap and `/__hobo/replay/*` serves ingest/list — **no app tracker code required**. JSON API Kits still expose the ingest path on the same wrap.

| Piece | Package / surface |
|---|---|
| Annotation helper | `sessionReplay({ enabled?, sampleRate? })` from `hobo/bindles` |
| Kit taxonomy | `app kit kinds`, `isAppKitKind`, `appKitLabel` |
| Runtime plan + wrap | Session Replay bindle integration |
| Local host | `hobo dev` / Yard entrypoints |
| Ingest path | `/__hobo/replay/*` |
| Response marker | `x-hobo-session-replay: 1` when HTML wrap applied |

```ts
import { bindle, sessionReplay } from "hobo/bindles";

export default bindle("shop", (b) => {
 const api = b.api(() => apiHandler); // API Kit — Session Replay default-on
 const web = b.web(() => storefront); // Web Kit — Session Replay default-on
 const worker = b.service(() => worker); // Service Kit — Session Replay default-on
 const cache = b.kv(); // Infra Kit — no default Session Replay
 // opt out one Kit:
 // const api = b.api(() => apiHandler).with(sessionReplay({ enabled: false }));
 return { api, web, worker, cache };
});
```

## Privacy (client-side before send/persist)

- Mask password / email / tel inputs
- Mask `[data-hobo-mask]`, `.hobo-mask`, payment autocomplete fields
- Redact `Authorization` / `Cookie` in network capture
- Continuous-identity **`principalRef` only** — no free-text PII

## CLI / MCP

```text
hobo replay doctor
hobo replay list
hobo replay get <sessionId>
hobo replay summarize <sessionId>
hobo replay open <sessionId>
hobo replay retention
```

MCP tool parity via canonical verbs. Player surfaces are read-oriented; mutation stays on CLI under policy/PAM. `hobo doctor` lists contract boundary ids.

## Event family (`replay.*`)

`Started` · `ChunkIngested` · `Ended` · `ErrorLinked` · `RetentionApplied` · `Accessed` · `Disabled` · `Metered`

## Composition

| Composes with | How |
|---|---|
| **App Kits** | Default annotation + host wrap on every Kit |
| **Station** | Isolation + local path |
| **Harness / OpenFeature** | Prod enablement + sampling |
| **Trails** | Platform recipe `replay.retention` |
| **Continuous identity** | Principal refs only |
| **Metering** | Ingest bytes, storage, player access |
| **PAM** | Access policy for open/list |
| **PACT** | Integration boundaries via the replay HTTP surface |

## Performance budget (targets)

| Metric | Budget |
|---|---|
| Batch interval | 1000 ms |
| Batch size | 50 events |
| Main-thread per flush | ≤ 16 ms |
| Tracker overhead beyond rrweb | ≤ ~15 KB gzipped |

## Honest scope

- Live multi-cloud object storage + Junction federation: **ports present**; dual fixtures prove the path
- Full OpenReplay Assist / Helm stack: **optional**, not default
- High-volume product analytics warehouse: **residual**

## Related

[Bindles](/HoBo/primitives/bindles/) · [App Kits](/HoBo/primitives/app-kits/) · [Trail map](/HoBo/guide/status/) · [Harness](/HoBo/reference/harness/) · [CLI](/HoBo/reference/cli/) · [Event families](/HoBo/reference/events/) · [Dual fixtures](/HoBo/testing/dual-fixtures/) · [Stations](/HoBo/primitives/stations/)
