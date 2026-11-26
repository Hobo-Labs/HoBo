# Client Optimistic Update Contract POC

Independent POC for HOBO-256, layered on the HOBO-76 read surface and HOBO-85 reads-your-writes contract.

## Contract Surface

- `createOptimisticSubscription(...)` maintains client-visible subscription state as authoritative data plus pending optimistic patches.
- `applyOptimisticPatch(...)` applies a command patch immediately while keeping the visible `seq` pinned to the last authoritative push.
- `receiveAuthoritativePush(...)` reconciles and drops patches when the push reaches the command's `seq` floor.
- `rejectCommand(...)` rolls back a pending optimistic patch and records an audit fact.
- `OptimisticSeqRegressionError` rejects any authoritative push that would move a stream's `seq` backward.

## Acceptance Evidence

- Optimistic patches show immediately and reconcile on authoritative push at the command `seq`.
- Rejected commands roll back without stuck optimistic state.
- Optimistic values never advance or regress the authoritative `seq`.
- Authoritative snapshots cannot omit a previously tracked stream `seq`.
- Overlapping patches replay in command `seq` order.
- If the authoritative push arrives before the local patch is applied, the patch becomes a no-op.

## Scope Boundary

This package does not implement server-side command handling, Reactor scheduling, Streamer transport, cross-aggregate saga conflict resolution, GraphQL facade updates, or persistence of the client cache. It proves only the client-side optimistic patch and reconciliation contract.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\client-optimistic-update-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Client Optimistic Update Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
