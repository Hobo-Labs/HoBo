# No-Egress Generation Sandbox Contract POC

This draft covers HOBO-320. It defines the contract the generation pipeline
uses to declare that a validation run happened inside a no-egress sandbox.

## Contract

- `hobo.sandbox.profile/v1` profiles are deny-by-default and require:
  - `isolation.tier = "microvm"` and `isolation.engine = "firecracker"`.
  - `network.mode = "none"` with an empty allow list.
  - capability grants with an explicit `scope`.
  - writable filesystem paths contained by the scratch directory.
  - positive CPU, memory, and wall-clock budgets.
- `declareConformanceRun()` records that `@hobo/conformance` ran under a
  validated profile by storing the profile id, stable digest, target suite,
  artifact kind, and target WIT port.
- `sandbox.EscapeAttemptBlocked` events carry the denied attempt evidence for
  network, filesystem, or capability escape attempts.

## Out Of Scope

This does not implement a Firecracker runner, WIT host, or conformance suite.
It only makes the generation-with-egress case unrepresentable at the profile
contract boundary.

## Verification

```bash
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for No Egress Generation Sandbox Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
