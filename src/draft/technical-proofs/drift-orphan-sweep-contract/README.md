# HOBO-373 Drift Orphan Sweep Contract

Independent POC for adversarial drift reconciliation conflicts from
[Plan 04](../../../../docs/design/control-plane.md#plan-04),
[ADR-0004](../../../../docs/design/adr/01-architecture-core.md#adr-0004), and
[ADR-0006](../../../../docs/design/adr/01-architecture-core.md#adr-0006).

## Proof Surface

- `runDriftOrphanSweep(...)` models the reconciliation pass after provider refresh.
- The package proves tag contract enforcement, created-but-not-in-state orphan sweep without duplicate
  creation, deterministic single-writer race outcomes, out-of-band drift decisions, rollback
  interleaving, cross-deployment isolation, and resumable partial sweep failures.

## Scope Boundary

This POC does not implement provider adapters, the base drift loop, production tagging hooks, manual
policy authoring, or ResourceActor runtime integration. It defines the contract those surfaces must
preserve.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\drift-orphan-sweep-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Drift Orphan Sweep Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
