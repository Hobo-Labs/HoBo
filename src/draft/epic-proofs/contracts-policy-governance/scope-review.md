# Adversarial Scope Review

This review was completed before implementation for run `sprawl-20260629T015519Z-2df8`.

## Scope boundary

In scope:

- One epic only: Contracts, Policy & Governance.
- One common reference path: `src/draft/epic-proofs/contracts-policy-governance/`.
- Reference architecture orchestration, local mocks, Pact-style boundary contracts, simulation, and docs.
- Existing POCs used as behavior and contract evidence.

Out of scope:

- Production control-plane code.
- Live external policy engines, feature-flag providers, cost services, registries, identity systems, or artifact-signing services.
- Repairing separate child PRs unless they block this reference implementation.
- Marking any accepted POC `Done` solely because the reference implementation started.

## POC review

| POC | Requirement proven | Kept | Accidental or unsafe if copied blindly | Contract decision | Disposition |
|---|---|---|---|---|---|
| `hobo-policy-ir-contract` | Policy decisions need a stable envelope. | Decision validation, deterministic evidence. | Treating IR validation as full policy semantics. | Gatekeeper to Policy Engine. | accepted_for_reference_impl |
| `hobo-contract-ir` | Contract modes must be explicit and compatible with deploy gates. | Four-mode contract shape and compatibility metadata. | Expanding into a production schema registry. | Gatekeeper to Contract Engine. | accepted_for_reference_impl |
| `contract-engine-port-contract` | Contract engine is built in, with Pact interop only. | Consumer-driven interaction shape. | Depending on external Pact broker or live provider. | Gatekeeper to Contract Engine. | accepted_for_reference_impl |
| `can-deploy-compatibility-gate-contract` | Deploys need consumer/provider compatibility evidence. | Matrix evaluation and fail-safe denial. | Turning can-deploy into deploy orchestration. | Gatekeeper to Contract Engine and deployed-state projection. | accepted_for_reference_impl |
| `deny-ceiling-algebra-poc` | Lower scopes cannot weaken mandatory governance. | Mandatory deny union and deterministic merge. | Letting bindle policy override yard policy. | Gatekeeper to Policy Engine. | accepted_for_reference_impl |
| `built-in-policy-engine-contract` | Built-in policy must fail closed and audit decisions. | Deny-by-default and audit evidence. | Treating mock rules as product policy authoring. | Gatekeeper to Policy Engine; Policy Engine to Audit Log. | accepted_for_reference_impl |
| `obligation-engine-contract` | Governance decisions can create required follow-up obligations. | Approval/canary lifecycle and forged satisfaction rejection. | Building a workflow engine or user task UI. | Gatekeeper to Obligation Engine. | accepted_for_reference_impl |
| `gatekeeper-verify-contract` | Gatekeeper aggregates mandatory gates. | Gate result aggregation, mandatory gate failure, incident exemption shape. | Hiding missing gate engines behind optimistic success. | Gatekeeper to all gate providers. | accepted_for_reference_impl |
| `policy-pack-federation-contract` | Policy packs must be signed and target-bound. | Signed envelope and fail-closed verification. | Making federation conflict resolution a full product feature. | Policy Engine to Policy Pack Registry. | accepted_for_reference_impl |
| `control-plane-action-taxonomy-contract` | Policy and RBAC need common action names. | Action taxonomy as policy input. | Building unrelated control-plane API behavior. | Policy Engine to RBAC Directory. | accepted_for_reference_impl |
| `rbac-role-binding-contract` | Principal context must be explicit. | Role/grant/binding fixture behavior. | Implementing identity-provider or tenant admin UX. | Policy Engine to RBAC Directory. | accepted_for_reference_impl |
| `policy-fail-closed-contract` | Policy uncertainty denies deploys. | Outage, invalid rules, and missing-input denial. | Retrying or suppressing uncertainty. | Gatekeeper to Policy Engine. | accepted_for_reference_impl |
| `policy-supply-chain-trust-contract` | Policy and artifact trust are separate inputs. | Trust metadata as provenance fixture. | Handling real signatures or secrets. | Policy Engine to Policy Pack Registry; Gatekeeper to Artifact Provenance Verifier. | accepted_for_reference_impl |
| `governance-conformance-suite-contract` | Governance evidence must be replayable. | Replay dimensions and conformance report. | Making conformance suite a broad e2e test runner. | Governance Suite to Evidence Store. | accepted_for_reference_impl |
| `federated-policy-pack-conflict-contract` | Policy-pack conflicts need deterministic handling. | Conflict as negative evidence for deny ceiling. | Full federation conflict UX. | Covered by Policy Pack Registry contract. | deferred |
| `no-privilege-escalation-policy-contract` | RBAC must prevent privilege escalation. | Negative case for principal/action mismatch. | Separate policy engine branch. | Covered by RBAC Directory contract. | deferred |
| `openfeature-provider-adapters-contract` | Flags can be governed by policy. | Boundary concept only. | Live adapter calls and provider-specific behavior. | Split follow-up. | split_follow_up |
| `data-governance-residency-contract` | Residency can be a governance dimension. | Mocked conformance dimension only. | Data-plane residency implementation. | Split follow-up. | split_follow_up |
| `guardrail-policy-gate-contract` | AI guardrails can be governance gates. | Mocked fail-closed dimension only. | AI safety runtime implementation. | Split follow-up. | split_follow_up |
| `quota-cost-policy-contract` | Cost/quota can block deploy. | Mocked cost/quota boundary. | Budget service or quota product implementation. | Gatekeeper to Cost/Quota Policy, mocked provider unavailable. | deferred |
| `cross-yard-attestation-contract` | External attestation can affect deploy eligibility. | Boundary listed as future provider. | Network federation or trust exchange. | Split follow-up. | split_follow_up |
| `authz-cache-p99-contract` | Authz latency has product risk. | None in reference architecture. | Performance tuning unrelated to architecture slice. | Split follow-up. | split_follow_up |
| `control-plane-policy-bypass-guard` | Bypass attempts must be denied. | Negative scenario only. | Duplicating a separate open PR repair. | Ledger-only deferred. | deferred |
| `policy-engine-provider-adapters-contract` | External policy engines may be plugged in later. | Provider-unavailable mock strategy. | Provider SDK integration. | Split follow-up. | split_follow_up |
| `end-user-authorization-policy-contract` | End-user subject decisions inform RBAC. | Principal context shape. | Product authz UI/API. | Covered by RBAC Directory contract. | deferred |
| `observed-contract-promotion-contract` | Promotion evidence can feed can-deploy. | Evidence-store concept. | Promotion workflow. | Covered by deployed-state projection contract. | deferred |

## Conflict and drift checks

- Aggregate design docs say contract, policy, eval, conformance, cost, signing, golden-suite, and deployment-plan gates must be explicit. The reference implementation keeps these as gate decisions but only implements the selected epic's contract, policy, obligation, provenance, quota, and conformance facets.
- ADR-0015 requires no ambiguous pass-through. The simulation denies missing or uncertain providers.
- ADR-0096 requires constraint DAG thinking. The reference architecture records dependencies between contract compatibility, policy, obligations, and conformance rather than flattening them into one boolean.
- Open child PR evidence for HOBO-205 is not copied. The bypass concern is represented as a negative scenario so this run does not duplicate PR ownership.

## Contract brittleness review

- Pact-style fixtures assert boundary shape and required fields, not full internal rule evaluation.
- Consumer tests should validate interaction compatibility and provider-state assumptions only.
- External providers without repo implementations are documented as `mocked_provider_unavailable`.
- Simulation fixtures stay deterministic and local.

## Decision

Proceed with the accepted core POCs. Start integration by building a small Gatekeeper-centered reference harness that imports stable POC modules where useful, wraps missing providers with deterministic mocks, and writes Pact-style contract files for every listed boundary.
