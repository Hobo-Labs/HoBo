# HOBO-519 — Supervision Child Lifetime Contract

This proof records the SDK-visible supervision contract for child work attached
to workflows, steps, actors, sagas, and runbook-style parents.

## Evidence

- [`supervision-child-lifetime-contract`](../../../../src/draft/technical-proofs/supervision-child-lifetime-contract/README.md)
  proves invoked child cleanup on parent exit, spawned child teardown ownership,
  retry-budget escalation, cleanup trap audit, and replay-derived supervision
  inspection.
- The proof composes with HOBO-516 `resilience-semantics-annex`; it does not add
  Effect, XState, a distributed scheduler, a production supervision tree, or a
  queue backend.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\supervision-child-lifetime-contract test
npm.cmd test
npm.cmd run docs:design-lint
git diff --check
```
