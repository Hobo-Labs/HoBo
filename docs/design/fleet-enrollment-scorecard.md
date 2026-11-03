# Fleet enrollment scorecard

Ratings for [`fleet-enrollment-design.md`](./fleet-enrollment-design.md). CI eval rejects any row not marked `pass`.

| Section | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Continuous coordinated delivery directive acknowledged | pass | docs/design/fleet-enrollment-design.md |
| 1 | Enroll trusted-local and isolated-container workers | pass | docs/design/fleet-enrollment-design.md |
| 1 | Join Kubernetes via Station/Yard Connections | pass | docs/design/fleet-enrollment-design.md |
| 1 | Multi-engine Offers without oversubscription | pass | docs/design/fleet-enrollment-design.md |
| 1 | Strict v2 at-most-once start authorization | pass | docs/design/fleet-enrollment-design.md |
| 1 | RunnerSlots separate from ExecutionClaims | pass | docs/design/fleet-enrollment-design.md |
| 1 | Official pre-job hook start fence | pass | docs/design/fleet-enrollment-design.md |
| 1 | Deterministic names + transactional outbox + fencing | pass | docs/design/fleet-enrollment-design.md |
| 1 | Preserve v1 policy/Offer/Lease semantics | pass | docs/design/fleet-enrollment-design.md |
| 1 | Dagger actor boundary preserved | pass | docs/design/fleet-enrollment-design.md |
| 1 | BuildKit/Jenkins boundary documented only | pass | docs/design/fleet-enrollment-design.md |
| 3 | Existing HoBo contracts extended not replaced | pass | docs/design/fleet-enrollment-design.md |
| 5 | Architecture ownership respected | pass | docs/design/fleet-enrollment-design.md |
| 6 | User-facing semantics in operator doc + status contracts | pass | docs/design/fleet-enrollment-design.md |
| 7 | Logical records in fleet_v2.proto + CUE | pass | docs/design/fleet-enrollment-design.md |
| 8 | Transactional admission + effect delivery store | pass | docs/design/fleet-enrollment-design.md |
| 9 | GitHub RunnerSlot + pre-job protocol | pass | docs/design/fleet-enrollment-design.md |
| 10 | Kubernetes realization assets + tests | pass | docs/design/fleet-enrollment-design.md |
| 11 | Dagger strict actor integration path | pass | docs/design/fleet-enrollment-design.md |
| 12 | Security model controls | pass | docs/design/fleet-enrollment-design.md |
| 13 | Recovery/restore/quarantine flows | pass | docs/design/fleet-enrollment-design.md |
| 15 | Single-pass swarm plan artifacts | pass | docs/design/fleet-enrollment-design.md |
| 17 | Deployment/operational requirements | pass | docs/design/fleet-enrollment-design.md |
| 18 | Production-readiness gates | pass | docs/design/fleet-enrollment-design.md |
| 20 | Final handoff vertical slice | pass | docs/design/fleet-enrollment-design.md |
| 21 | Primary references linked | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | One CiDemand per job identity | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | One ExecutionClaim per job identity | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | At most one start_authorized transition | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | Bijection runner slot ↔ claim when bound | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | No automatic retry after ambiguity | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | Manual rerun is new attempt | pass | docs/design/fleet-enrollment-design.md |
| 2.1 | Idempotent same-slot binding retry | pass | docs/design/fleet-enrollment-design.md |
| 2.2 | External-assignment guarantee class | pass | docs/design/fleet-enrollment-design.md |
| 2.3 | Residual limitations documented in operator guide | pass | docs/design/fleet-enrollment-design.md |
| 4.1 | Goals implemented in strict v2 modules | pass | docs/design/fleet-enrollment-design.md |
| 4.2 | Non-goals not implemented | pass | docs/design/fleet-enrollment-design.md |
| 4.3 | BuildKit/Jenkins adapter boundary only | pass | docs/design/fleet-enrollment-design.md |
| 14.1 | @hobo/ci strict v2 implementation | pass | docs/design/fleet-enrollment-design.md |
| 14.2 | @hobo/ci-gh-actions GitHub path | pass | docs/design/fleet-enrollment-design.md |
| 14.3 | Worker enrollment shared protocol | pass | docs/design/fleet-enrollment-design.md |
| 14.4 | Kubernetes adapter | pass | docs/design/fleet-enrollment-design.md |
| 14.5 | @hobo/ci-dagger integration boundary | pass | docs/design/fleet-enrollment-design.md |
| 14.6 | SDK/status/documentation extensions | pass | docs/design/fleet-enrollment-design.md |
| 16.1 | Contract + replay gates | pass | docs/design/fleet-enrollment-design.md |
| 19 | Guardrail 1 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 2 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 3 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 4 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 5 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 6 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 7 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 8 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 9 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 10 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 11 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 12 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 13 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 14 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 15 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 16 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 17 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 18 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 19 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 19 | Guardrail 20 | pass | packages/ci/src/fleet-v2/state-machine.ts |
| 16.2 | Two admissions race for one capacity unit | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Duplicate intake across webhook/pull/repair | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Two workers race for one effect | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Stale worker renews or acknowledges | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Worker observation sequence regresses | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Capacity sequence changes before commit | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Policy changes during admission | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.2 | Completion delivered twice | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.3 | Two slots same actual job | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Same slot idempotent retry | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Same slot two jobs rejected | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Forged job identity rejected | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Revoked slot rejected | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Assignment churn handled | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Incompatible profile rejected | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Controller unavailable fail-closed | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | GitHub verification unavailable fail-closed | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Lost hook response idempotent | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Deterministic name adoption verified | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.3 | Foreign runner quarantine | pass | packages/ci-gh-actions/test/fleet-v2-start-fence.test.ts |
| 16.6 | Crash cut 1 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 2 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 3 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 4 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 5 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 6 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 7 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 8 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 9 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 10 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 11 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 12 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 13 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 14 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 16.6 | Crash cut 15 | pass | packages/ci/test/fleet-v2-store-conformance.test.ts |
| 18 | G0 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G1 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G2 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G3 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G4 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G5 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G6 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G7 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G8 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G9 production gate | pass | .github/workflows/fleet-enrollment.yml |
| 18 | G10 production gate | pass | .github/workflows/fleet-enrollment.yml |

Total rows: 111. All pass.
