# HOBO-21 ActorHost Runtime Port Proof

This proof backs [PLAN-02](../../sdk-api.md#plan-02),
[PLAN-11](../../data-plane.md#plan-11), [PLAN-20](../../wasm-runtime-wit.md#plan-20),
[ADR-0002](../../adr/01-architecture-core.md#adr-0002), and
[ADR-0053](../../adr/03-data-plane.md#adr-0053).

The branch adds `src/draft/technical-proofs/actor-host-runtime-port-contract`, an independent POC
for the Layer 1 `ActorHost` runtime port. It proves actor-key ownership,
fencing-token rejection, lease expiry/renewal, and durable state replay without
implementing the separate EventStore port, command aggregate idiom, Reactor, or
cross-Camp ownership semantics.

## HOBO-595 draft extension (S1-06)

[HOBO-595](https://linear.app/quickdeploy-ai/issue/HOBO-595) extends this proof with:

- `createLocalActorHost` over the draft camp EventStore (`actor:<key>` streams, lifecycle events).
- Six ActorHost conformance checks (`actor-host.single-writer`, `actor-host.stale-fence-rejected`, and four siblings), dual-activation fixture, and broken-fence negative backend.
- PACT interactions promoted from the wit-membrane actor-host boundary shape.

Production promotion target remains `@hobo/runtime-local` once S1-05 (`@hobo/core` EventStore port)
lands on `main`; this draft does not import production packages.

## Acceptance Evidence

- Two active acquirers for one actor key cannot both win; the second acquirer is
  rejected while the first lease is live.
- A delayed writer with an older fence token is rejected after a later lease wins.
- A forged copy of the live lease's public fields cannot append without the
  opaque lease identity returned by `acquire()`.
- Live lease fencing metadata is immutable, and append records use the host-local
  lease record rather than caller-mutated public fields.
- An expired zombie lease is rejected even before a newer fence token exists.
- Lease renewal extends the current writer's deadline without minting a second
  fence token.
- Passivation snapshots the folded state, releases the active lease, and later
  activation rebuilds from snapshot plus tail events to the same state.

## Scope Boundary

The POC includes a small in-memory stream because `ActorHost.state<S>(key)` must
prove durable fold semantics. It intentionally does not claim HOBO-20 EventStore
coverage: no provider persistence, subscription, idempotency-key deduplication,
poison quarantine, or EventEnvelope publication is implemented here.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\actor-host-runtime-port-contract test
npm.cmd test
```
