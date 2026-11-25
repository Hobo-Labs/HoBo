# ActorHost Runtime Port Contract POC

Independent draft POC for [HOBO-21](https://linear.app/quickdeploy-ai/issue/HOBO-21) and
[HOBO-595](https://linear.app/quickdeploy-ai/issue/HOBO-595). Pins the `ActorHost` runtime-port
behavior from `docs/design/sdk-api.md#plan-02`, `docs/design/data-plane.md#plan-11`,
ADR-0002, and ADR-0053.

## Contract Surface

- `createInMemoryActorHost({ clock, leaseTtlMs })` — in-memory stream oracle from HOBO-21.
- `createLocalActorHost({ clock, eventStore, leaseTtlMs })` — EventStore-backed adapter (HOBO-595)
  using the draft camp EventStore proof; actor streams use id `actor:<key>` and lifecycle facts
  `actor.Activated` · `actor.StateAppended` · `actor.Passivated`.
- `parseActorKey` / `parseHolderId` — branded parse-don't-validate boundary types.
- `runActorHostConformance(createBackend)` — six `actor-host.*` checks plus dual-activation fixture.
- `createBrokenFenceActorHostBackend()` — negative backend that must fail `actor-host.stale-fence-rejected`.

## Scope Boundaries

Included:

- Single-writer lease acquisition with monotonic fence tokens.
- Opaque lease identity, renewal without new fence, expiry/zombie/stale-fence rejection.
- Durable fold, snapshot-on-passivation, snapshot-plus-tail replay.
- Conformance checks and PACT boundary for promotion to `@hobo/runtime-local`.

Excluded:

- Cross-Camp ownership/failover (ADR-0040).
- CQRS command aggregate ergonomics, Queue/Clock, Streamer, WIT surface.
- Production `packages/` promotion (blocked on S1-05 EventStore merge); this draft reuses the
  camp EventStore proof instead of `@hobo/runtime-local`.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/actor-host-runtime-port-contract test
```

## Architecture Evidence

- `architecture/` — protobuf + CUE for `LeaseInfo`, `ActorEventRecord`, `AppendReceipt`, `ActorStateSnapshot`.
- `architecture/pacts/actor_host_runtime_port_contract.pact.json` — consumer `@hobo/conformance`, provider `@hobo/runtime-local`.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
