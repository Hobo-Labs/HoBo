# `@hobo/replay`

Privacy-first **Session Replay** for HoBo web apps and Stations (ADR-0137).

Captures user sessions with an **rrweb-compatible** engine, stores heavy blobs
out-of-band (dual fixtures locally, object-storage port in production), and
emits lightweight `replay.*` lifecycle events for correlation with Trails,
Harness/OpenFeature, continuous identity, and the control-plane event log.

> **Naming.** Control-plane “replay” means replaying the durable event log for
> projections/audit. **Session Replay** is DOM/session reconstruction. Auth
> still owns `session.Started|Refreshed|Revoked`. This package uses the
> `replay.*` event family and package id `@hobo/replay`.

## Default local path

### Every App Kit is Session-Replay capable (no app code required)

**App Kit** (Kit) = Bindle-declared application surface — `api`, `web`, `service`,
`ui`, `websocket`, `job`, `wasm-component`. Prefer this term over "membrane type"
at the Bindle layer (the WIT/WASM membrane stays the low-level portability
contract).

Any Kit auto-attaches `session-replay`. Local Yard hosts (`hobo dev`) wrap every
HTTP App Kit so that:

1. HTML responses get a privacy-first bootstrap (`data-hobo-replay`)
2. Batches POST to `/__hobo/replay/ingest` on the same origin (API Kits too)
3. Agents/CLI can list via `hobo replay list` / `/__hobo/replay/sessions`

```ts
bindle("shop", (b) => ({
  api: b.api(apiHandler),       // API Kit — replay on by default
  web: b.web(storefront),       // Web Kit — replay on by default
  worker: b.service(worker),    // Service Kit — replay on by default
  cache: b.kv(),                // Infra Kit — no default replay
}));
```

Opt out per Kit:

```ts
import { bindle, sessionReplay } from "@hobo/bindles";

bindle("app", (b) => ({
  api: b.api(handler).with(sessionReplay({ enabled: false })),
}));
```

Kill switch: `HOBO_REPLAY=0`.

### Programmatic dual fixtures

```ts
import {
  createReplayService,
  createFixtureRecordEngine,
} from "@hobo/replay";

const replay = createReplayService({ stationId: "station:local", memory: true });
const tracker = replay.startRecording({
  seedEvents: [{ type: 2, timestamp: Date.now(), data: { tagName: "div" } }],
});
await tracker.flush();
const session = await tracker.stop();
console.log(await replay.summarize(session!.id));
// open: await replay.open(session!.id, [/* blob refs */])
```

CLI:

```bash
hobo replay doctor
hobo replay list
hobo replay get <sessionId>
hobo replay summarize <sessionId>
hobo replay open <sessionId>
hobo replay retention
```

Kill switch: `HOBO_REPLAY=0` (or OpenFeature flag `hobo.session-replay=false`).

## Privacy defaults

Client-side before send/persist:

- Mask password / email / tel inputs
- Mask `[data-hobo-mask]`, `.hobo-mask`, payment autocomplete fields
- Redact `Authorization` / `Cookie` headers in network capture
- Continuous-identity `principalRef` only (no free-text PII)

## Production gating

| Environment | Default |
|---|---|
| local-dev / dual fixtures / Station air-gap | **On** |
| production / staging | **Off** (flag or sample rate required) |

## Honest Scope

- Live multi-cloud object storage + Junction federation: **port present**, dual fixtures are the proof path
- Full OpenReplay Assist / Helm stack: **optional Station template**, not default
- High-volume ClickHouse product analytics: **residual**

## Performance budget

| Metric | Budget |
|---|---|
| Batch interval | 1000 ms |
| Batch size | 50 events |
| Main-thread per flush | ≤ 16 ms target |
| Tracker overhead beyond rrweb | ≤ ~15 KB gzipped |

## Accessibility surface + PACT

Every integration boundary — **including internal module edges** — is reachable
via `createReplayHttpSurface` and listed by `REPLAY_BOUNDARIES` /
`service.doctor().boundaries`.

```ts
import { createReplayHttpSurface, REPLAY_BOUNDARIES } from "@hobo/replay";

const surface = createReplayHttpSurface({ stationId: "station:local" });
await surface.handle({
  method: "POST",
  path: "/replay/sessions/sess-1/chunks",
  body: { seq: 0, events: [{ type: 2, timestamp: 1, data: {} }] },
});
console.log(REPLAY_BOUNDARIES.map((b) => b.id));
```

Full inventory: [`contracts/pact-inventory.md`](./contracts/pact-inventory.md).
Provider verification: `pnpm --filter @hobo/replay test` runs
`test/pacts/provider-verify.pact.test.ts` (contract-harness `verifyPact` against
real modules + dual fixtures).

## Related

- ADR-0137 (Session Replay)
- Experience proof: `src/draft/exp-proofs/dx/session-replay-local-path`
- Technical proof: `src/draft/technical-proofs/session-replay-contracts`
