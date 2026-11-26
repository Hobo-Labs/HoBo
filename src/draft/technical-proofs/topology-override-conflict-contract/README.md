# Topology Override Conflict Contract

Independent POC for HOBO-204. It proves topology overrides are checked at
`can-deploy` against the Junction-inferred connectivity plan instead of being
silently applied over inference.

## Proof surface

- Conflicting DNS or connectivity-tier overrides emit deterministic
  `topology.OverrideConflictDetected` decisions.
- Yard-scope and Camp-scope overrides that disagree produce the same conflict
  identity regardless of input order.
- Mandatory tier ceilings reject widening overrides before connectivity changes.
- Residency-changing overrides fail closed with a precise error.
- Overrides cannot re-open a path that Junction inference already closed.
- Overrides based on stale topology sequence or inference hash require re-gating.

## Out of scope

- The override declaration surface remains owned by the Yard manifest model.
- Junction inference remains owned by `junction-connectivity-plan-contract`.
- The policy engine remains owned by governance; this package consumes its
  can-deploy decision and constraints.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\topology-override-conflict-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Topology Override Conflict Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
