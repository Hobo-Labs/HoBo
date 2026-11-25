# HOBO-256 Client Optimistic Updates Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32) and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/client-optimistic-update-contract`](../../../../src/draft/technical-proofs/client-optimistic-update-contract)
proves the M3 client optimistic-update contract:

- a command's optimistic patch is visible immediately while the displayed `seq` remains the last authoritative one;
- an authoritative push at or beyond the command `seq` reconciles and removes the patch;
- a rejected command rolls back its patch and records an audit fact;
- overlapping patches replay in command `seq` order until each authoritative push arrives;
- an optimistic patch cannot cause a `seq` regression, and stale or incomplete authoritative seq
  vectors fail closed;
- if the authoritative push arrives before the local patch is applied, the patch is treated as already satisfied.

Scope kept out: server command handling, Reactor scheduling, transport delivery, GraphQL facade
updates, cross-aggregate saga conflict resolution, and persistent client cache storage.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\client-optimistic-update-contract test
```
