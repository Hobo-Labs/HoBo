---
type: Verification scorecard
title: "Fleet enrollment scorecard"
description: "Evidence and open verification work for CI fleet enrollment."
tags: [ci, fleet, verification]
---

# Fleet enrollment scorecard

Ratings for [`fleet-enrollment-design.md`](./fleet-enrollment-design.md). A `pass` names scoped evidence and its verified commit; it does not establish current production readiness. Refresh it when covered behavior changes. `not-verified` means no requirement-specific result is recorded, and `not-implemented` identifies a known implementation gap. The CI evaluation checks the status vocabulary and prevents unsupported blanket passes.

| Section | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Continuous coordinated delivery directive acknowledged | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Enroll trusted-local and isolated-container workers | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Join Kubernetes via Station/Yard Connections | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Multi-engine Offers without oversubscription | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Strict v2 at-most-once start authorization | not-implemented | Store, scoped GitHub lookup, and start handler exist, but the production controller does not connect them |
| 1 | RunnerSlots separate from ExecutionClaims | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Official pre-job hook start fence | not-implemented | Hook and optional start route exist, but the production controller does not install or configure them |
| 1 | Deterministic names + transactional outbox + fencing | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Preserve v1 policy/Offer/Lease semantics | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | Dagger actor boundary preserved | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 1 | BuildKit/Jenkins boundary documented only | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 3 | Existing HoBo contracts extended not replaced | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 5 | Architecture ownership respected | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 6 | User-facing semantics in operator doc + status contracts | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 7 | Logical records in fleet_v2.proto + CUE | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 8 | Transactional admission + effect delivery store | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 9 | GitHub RunnerSlot + pre-job protocol | not-implemented | The scoped lookup, hook, and optional start handler exist; live controller integration is not implemented |
| 10 | Kubernetes realization assets + tests | not-implemented | Pure planner functions + YAML assets only; no client execution path against a cluster |
| 11 | Dagger strict actor integration path | not-implemented | Boundary shapes only; no strict actor execution wired through Dagger |
| 12 | Security model controls | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 13 | Recovery/restore/quarantine flows | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 15 | Single-pass swarm plan artifacts | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 17 | Deployment/operational requirements | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | Production-readiness gates | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 20 | Final handoff vertical slice | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 21 | Primary references linked | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | One CiDemand per job identity | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | One ExecutionClaim per job identity | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | At most one start_authorized transition | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | Bijection runner slot ↔ claim when bound | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | No automatic retry after ambiguity | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | Manual rerun is new attempt | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.1 | Idempotent same-slot binding retry | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.2 | External-assignment guarantee class | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 2.3 | Residual limitations documented in operator guide | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 4.1 | Goals implemented in strict v2 modules | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 4.2 | Non-goals not implemented | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 4.3 | BuildKit/Jenkins adapter boundary only | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 14.1 | @hobo/ci strict v2 implementation | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 14.2 | @hobo/ci-gh-actions GitHub path | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 14.3 | Worker enrollment shared protocol | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 14.4 | Kubernetes adapter | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 14.5 | @hobo/ci-dagger integration boundary | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 14.6 | SDK/status/documentation extensions | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 16.1 | Contract + replay gates | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 19 | Guardrail 1 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 2 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 3 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 4 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 5 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 6 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 7 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 8 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 9 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 10 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 11 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 12 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 13 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 14 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 15 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 16 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 17 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 18 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 19 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 19 | Guardrail 20 | not-verified | No guardrail-specific test or review evidence is recorded; see design section 19 |
| 16.2 | Two admissions race for one capacity unit | pass | SQLite and PostgreSQL case "allows exactly one admission to race for one capacity unit" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.2 | Duplicate intake across webhook/pull/repair | pass | SQLite and PostgreSQL case "deduplicates intake across webhook, pull, and repair" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.2 | Two workers race for one effect | pass | SQLite and PostgreSQL case "allows one active delivery and fence when workers race" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.2 | Stale worker renews or acknowledges | pass | SQLite and PostgreSQL case "rejects stale delivery tokens across generated lease histories" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.2 | Worker observation sequence regresses | pass | SQLite and PostgreSQL case "rejects observation sequence regression without state change" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.2 | Capacity sequence changes before commit | pass | SQLite and PostgreSQL case "rejects a stale revision even when capacity remains" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.2 | Policy changes during admission | not-verified | A stale policy snapshot is tested, but a concurrent policy change during the transaction has no recorded result |
| 16.2 | Completion delivered twice | pass | SQLite and PostgreSQL case "settles duplicate completion and releases capacity once" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence |
| 16.3 | Two slots same actual job | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Same slot idempotent retry | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Same slot two jobs rejected | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Forged job identity rejected | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Revoked slot rejected | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Assignment churn handled | not-implemented | No live reassignment handling: the authorizer only confirms the assignment GitHub reports at hook time |
| 16.3 | Incompatible profile rejected | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Controller unavailable fail-closed | not-implemented | Hook template exits nonzero on curl failure, but the template is not installed by any controller |
| 16.3 | GitHub verification unavailable fail-closed | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Lost hook response idempotent | not-verified | Store or authorizer tests do not establish the unwired end-to-end GitHub start fence |
| 16.3 | Deterministic name adoption verified | not-implemented | Deterministic names are generated; inspecting and adopting an already-registered runner is not implemented |
| 16.3 | Foreign runner quarantine | not-implemented | Foreign-runner detection/quarantine has no implementation |
| 16.6 | Crash cut 1 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 2 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 3 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 4 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 5 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 6 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 7 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 8 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 9 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 10 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 11 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 12 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 13 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 14 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 16.6 | Crash cut 15 | not-verified | No crash-cut-specific fault-injection evidence is recorded; see design section 16.6 |
| 18.9 | G9 live: Trusted-local job on enrolled worker (private test repo) | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Isolated-required job on isolated worker | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Queued jobs with assignment churn; unique execution markers at most once | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Duplicate webhook deliveries without duplicate execution | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Controller kill before start: no steps; manual rerun succeeds at most once | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Worker kill after JIT: reconcile without second runner for same slot | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Worker revocation blocks subsequent starts | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Kubernetes strict runner-Pod job on real cluster | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Operator Dagger engine strict portable-pipeline path | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18.9 | G9 live: Staging backup/restore and rollback drills without duplicate execution | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18 | G0 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G1 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G2 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G3 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G4 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G5 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G6 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G7 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G8 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |
| 18 | G9 production gate | not-verified | Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9 |
| 18 | G10 production gate | not-verified | No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md |

Total rows: 121. Pass: 7. Not verified: 105. Blocked on credentials (G9 live staging): 0. Not implemented: 9.
