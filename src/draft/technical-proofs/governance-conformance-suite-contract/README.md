# Governance Conformance Suite Contract

HOBO-227 pins the GA governance composition boundary for `hobo verify` without implementing the
individual engines. The package consumes fixture-shaped gate results from the existing contract,
policy, obligation, residency, guardrail, quota, and signing slices, composes them into one
deployability decision, and replays that decision from the emitted event log.

Scope stays at the conformance seam:

- no policy, contract, quota, guardrail, residency, or signing engine implementation;
- no CLI implementation beyond the fixture shape a `hobo verify` suite would consume;
- no doc-lint replacement; traceability validation is limited to the governance ADR/Plan map named
  by HOBO-227.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\governance-conformance-suite-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Governance Conformance Suite Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
