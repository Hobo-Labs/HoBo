# HoBo Dev Fidelity Drift Contract

HOBO-190 proof for adversarial hardening of `hobo dev` local-to-Camp fidelity claims and
`--fork` request-lane isolation.

## What This Proves

- A capability declared `simulated` fails the fidelity audit when the only evidence is `mocked`.
- Prod-ready claims from mocked-only or Camp-unrun evidence are refused with a defer-to-Camp result.
- `--fork` lanes keep writes out of the shared baseline and out of other concurrent lanes.
- A capability labeled `real` fails when local evidence drifts from Camp evidence.
- Missing fidelity labels default to `camp-only`, never `real`.
- Local mocks drifting from the contract are reported as drift.
- Clock-driven simulated behavior must replay identically after restart.
- Partition or incident evidence blocks confident local success claims.

## Boundary

This is an executable contract for the honesty gate around `hobo dev`; it does not implement the
full dev daemon, production backends, Camp conformance suites, or `hobo verify` orchestration. It
consumes those surfaces and hardens their fidelity reporting contract.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-dev-fidelity-drift-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Dev Fidelity Drift Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
