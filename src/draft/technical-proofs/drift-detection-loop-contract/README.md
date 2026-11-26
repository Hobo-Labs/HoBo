# HOBO-366 Drift Detection Loop Contract

Independent POC for the periodic ResourceActor resync loop. It keeps refresh and provider/IaC
implementations out of scope and proves the control-plane contract around consuming `DriftReport`
results, serializing with in-flight reconcile work, and recording auditable `resource.*` drift
transitions.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\drift-detection-loop-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Drift Detection Loop Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
