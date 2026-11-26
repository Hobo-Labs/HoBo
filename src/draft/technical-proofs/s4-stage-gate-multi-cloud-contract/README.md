# HOBO-645 S4 Stage Gate Multi-Cloud Contract

Independent proof for **HOBO-645** (S4-09). Closes the Stage-4 gate as a
CI-runnable drill on `examples/multi-cloud-shop` per OBJ-1 and
`requirements.md` Stage 4.

## Contract Surface

- `createS4StageGateEvidence()` composes portability, cross-cloud SVID mTLS,
  J3 camp-only provider switch, and installed-pack matching evidence.
- `verifyS4StageGate()` fails closed when any Stage-4 acceptance bullet is not met.
- `runS4StageGateDrill()` is the credentialed CI entry point; evidence attaches
  to the S4-01 acceptance record path.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Same unedited Bindle deploys to AWS and Azure via mapping rules | `S4 stage gate: same unedited Bindle deploys to AWS and Azure via mapping rules` |
| Cross-cloud services connect over SVID-keyed mTLS | `S4 stage gate: cross-cloud services connect over SVID-keyed mTLS` |
| Required-but-unoffered capability → `deployment.PlanRejected` | `S4 stage gate: unsatisfied require rejects with precise deployment.PlanRejected` |
| Switching one resource's provider touches only Camp mapping (J3) | `S4 stage gate: switching orders provider touches only Camp mapping (J3)` |
| Resource Definitions/Matching + installed Pack participate | `S4 stage gate: installed pack definition wins matching with match.Decided evidence` |
| Drill green in credentialed lane | `credentialed camp-tagged drill lane emits green fixture report` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Cross-cloud call without valid SVID mTLS | `adversarial: cross-cloud mTLS without valid SVID session fails the drill` |
| J3 switch edits Bindle bytes | `adversarial: J3 switch that edits Bindle bytes fails closed` |
| Installed pack does not win matching | `adversarial: platform default wins over installed pack when pack match is removed` |

## Boundary

This POC does not provision real AWS/Azure infrastructure, implement Junction
federation, or replace S4-07/S4-08 production lanes. It defines the reviewable
Stage-4 gate contract those slices must satisfy and composes existing draft
contracts for portability, mTLS, and matching.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s4-stage-gate-multi-cloud-contract test
node --import tsx src/draft/technical-proofs/s4-stage-gate-multi-cloud-contract/scripts/run-s4-stage-gate-drill.ts --phase deploy-and-assert --run-id local
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
