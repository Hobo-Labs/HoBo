# POC Rollup Ledger

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Generation pipeline IO contract + gen.* event family | `src/draft/technical-proofs/generation-pipeline-io-contract` | HOBO-307 | Platform engineer | Generated request emits replayable events through validation and certification | Cold-start provider certification | Sandbox, certification registry | generation-sandbox-validation, generation-certification-registry | verified | implemented_in_reference_impl | Event family is consumed through the reference run. |
| Eval rubric + promotion gate | `src/draft/technical-proofs/eval-promotion-gate-contract` | HOBO-309 | ML operations engineer | Candidate promotes only after eval and policy pass | Training and eval promotion | Promotion policy gate | training-promotion-policy-gate | verified | implemented_in_reference_impl | Live eval runtime uses the same gate vocabulary. |
| SLSA-style provenance + signed certification descriptor | `src/draft/technical-proofs/slsa-provenance-certification-contract` | HOBO-312 | Platform engineer | Certification carries signed provenance | Cold-start provider certification | Certification registry | generation-certification-registry | verified | implemented_in_reference_impl | Certification descriptor is produced by the reference run. |
| Training-engine WIT port + trajectory/OpenInference capture | `src/draft/technical-proofs/training-engine-port-contract` | HOBO-317 | ML operations engineer | Trajectories feed bounded optimizer requests | Training and eval promotion | Trajectory store | training-trajectory-store | verified | implemented_in_reference_impl | Training request and candidate patch are executed. |
| No-egress generation sandbox boundary | `src/draft/technical-proofs/no-egress-generation-sandbox-contract` | HOBO-320 | Platform engineer | Sandbox proves no live egress before certification | Cold-start provider certification | Sandbox | generation-sandbox-validation | verified | implemented_in_reference_impl | Sandbox profile digest is part of simulation output. |
| Scaffold stage templates | `src/draft/technical-proofs/generation-scaffold-stage-contract` | HOBO-321 | Platform engineer | Scaffold derives from artifact kind and target port | Cold-start provider certification | Sandbox | generation-sandbox-validation | verified | implemented_in_reference_impl | Reference run calls scaffold stage. |
| LLM-fill stage | `src/draft/technical-proofs/generation-llm-fill-contract` | HOBO-324 | Platform engineer | Fill treats material as untrusted hints | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Frozen prompt material remains delimited. |
| Validation stage | `src/draft/technical-proofs/generation-validation-stage-contract` | HOBO-327 | Platform engineer | Conformance and trace replay must pass | Cold-start provider certification | Sandbox | generation-sandbox-validation | verified | implemented_in_reference_impl | Final validation trace replay is asserted. |
| Bounded repair loop | `src/draft/technical-proofs/generation-bounded-repair-loop-contract` | HOBO-330 | Platform engineer | Failed validation repairs within budget or escalates | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Non-converging path is a negative test. |
| Promotion policy gate | `src/draft/technical-proofs/generation-promotion-policy-gate-contract` | HOBO-333 | Platform engineer | Certification requires policy evidence | Cold-start provider certification | Promotion policy, human approval | training-promotion-policy-gate, human-approval-safety-gate | verified | implemented_in_reference_impl | Modeled through certification and approval decisions. |
| OpenInference trajectory capture + trajectory store | `src/draft/technical-proofs/openinference-trajectory-capture-contract` | HOBO-335 | ML operations engineer | OpenInference spans are persisted as trajectories | Training and eval promotion | Trajectory store | training-trajectory-store | verified | implemented_in_reference_impl | Three deterministic trajectories are captured. |
| Built-in OPTO training-engine optimizer | `src/draft/technical-proofs/built-in-opto-training-engine-contract` | HOBO-338 | ML operations engineer | Optimizer proposes region-scoped candidate edits | Training and eval promotion | Trajectory store, promotion policy | training-trajectory-store, training-promotion-policy-gate | verified | implemented_in_reference_impl | Candidate screens ready-for-gate; shared JSON predicates now enforce the same string/object boundaries without changing candidate screening. |
| Live-evals runtime | `src/draft/technical-proofs/live-evals-runtime-contract` | HOBO-341 | ML operations engineer | Live evals write rewards and move gate state | Training and eval promotion | Trajectory store, promotion policy | training-trajectory-store, training-promotion-policy-gate | verified | implemented_in_reference_impl | Challenger reaches gate-passed. |
| Champion/challenger + shadow traffic promotion | `src/draft/technical-proofs/champion-challenger-promotion-contract` | HOBO-344 | ML operations engineer | Candidate applies only to generated region | Training and eval promotion | Promotion policy | training-promotion-policy-gate | verified | implemented_in_reference_impl | Promotion preserves hand-written guard; latest technical-proof change reconciled without changing the simulation. |
| Certify stage | `src/draft/technical-proofs/generation-certify-stage-contract` | HOBO-346 | Platform engineer | Certifier emits registry certification events | Cold-start provider certification | Certification registry | generation-certification-registry | verified | implemented_in_reference_impl | Registry events are included in cold-start run. |
| Cold-start generation reference run | `src/draft/technical-proofs/generation-reference-run-contract` | HOBO-348 | Platform engineer | Database provider certifies end to end | Cold-start provider certification | Sandbox, certification registry | generation-sandbox-validation, generation-certification-registry | verified | implemented_in_reference_impl | Main vertical slice. |
| Eval methodology spike | `src/draft/technical-proofs/generation-eval-methodology-spike` | HOBO-351 | ML operations engineer | Offline and live eval evidence share gate vocabulary | Training and eval promotion | Promotion policy | training-promotion-policy-gate | verified | implemented_in_reference_impl | Synthesized into live-eval and OPTO screening docs. |
| Material-input sanitization | `src/draft/technical-proofs/generation-material-sanitization-contract` | HOBO-352 | Platform engineer | Untrusted material is scrubbed before fill | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Sanitized and refused material paths are simulated. |
| Malicious/backdoored generated code detection | `src/draft/technical-proofs/generation-safety-gate-contract` | HOBO-355 | Security reviewer | Unsafe generated code is denied | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Network exfiltration negative case is asserted. |
| Training/data flywheel poisoning guard | `src/draft/technical-proofs/training-data-poisoning-guard-contract` | HOBO-358 | ML operations engineer | Poisoned labels are quarantined | Training and eval promotion | Trajectory store, promotion policy | training-trajectory-store, training-promotion-policy-gate | verified | implemented_in_reference_impl | Trusted and poisoned label paths are simulated. |
| Human-in-loop gates against automation bias | `src/draft/technical-proofs/human-approval-generation-gate-contract` | HOBO-360 | SRE | Production generated changes require human approval | Live-fix gated candidate | Human approval, promotion policy | human-approval-safety-gate, training-promotion-policy-gate | verified | implemented_in_reference_impl | Prod approval-required path is asserted. |
| Data-flywheel privacy model | `src/draft/exp-proofs/dx/data-flywheel-privacy-spike` | HOBO-364 | ML operations engineer | Optimizer receives redacted trajectory payloads | Training and eval promotion | Trajectory store | training-trajectory-store | verified | implemented_in_reference_impl | Raw PII is absent from optimizer payload. |
| Live-fix gated candidate | `src/draft/technical-proofs/live-fix-gated-candidate-contract` | HOBO-368 | SRE | Failing trace creates a gated candidate | Live-fix gated candidate | Sandbox, promotion policy, human approval | generation-sandbox-validation, training-promotion-policy-gate, human-approval-safety-gate | verified | implemented_in_reference_impl | Prod candidate requires approval. |
| Cross-layer generated-stack propagation | `src/draft/technical-proofs/cross-layer-generated-stack-propagation-contract` | HOBO-371 | SRE | Domain record propagates across five layers | Live-fix gated candidate | Promotion policy, human approval | training-promotion-policy-gate, human-approval-safety-gate | verified | implemented_in_reference_impl | Generated-region drift check stays clean; latest technical-proof change reconciled without changing the simulation. |

| Generation pipeline IO cascade absorption | `src/draft/technical-proofs/generation-pipeline-io-contract` | HOBO-307 | Platform engineer | Generated request emits replayable events through validation and certification | Cold-start provider certification | Sandbox, certification registry | generation-sandbox-validation, generation-certification-registry | verified | implemented_in_reference_impl | Latest leaf validation is absorbed; simulation evidence unchanged. |
| Generation LLM-fill cascade absorption | `src/draft/technical-proofs/generation-llm-fill-contract` | HOBO-324 | Platform engineer | Fill treats material as untrusted hints | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Latest leaf validation is absorbed; safety evidence unchanged. |
| Generation bounded-repair cascade absorption | `src/draft/technical-proofs/generation-bounded-repair-loop-contract` | HOBO-330 | Platform engineer | Failed validation repairs within budget or escalates | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Latest leaf validation is absorbed; repair-budget evidence unchanged. |
| Generation material-sanitization cascade absorption | `src/draft/technical-proofs/generation-material-sanitization-contract` | HOBO-352 | Platform engineer | Untrusted material is scrubbed before fill | Cold-start provider certification | Sandbox, human approval | generation-sandbox-validation, human-approval-safety-gate | verified | implemented_in_reference_impl | Latest leaf validation is absorbed; sanitization evidence unchanged. |

## Cascade absorptions

Changes to referenced experience proofs that this rollup has taken in.

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/exp-proofs/dx/data-flywheel-privacy-spike` | `data-models/proof.cue` | none |

| `src/draft/technical-proofs/built-in-opto-training-engine-contract` | anti-slop JSON boundary cleanup | Candidate parsing and region-scoped screening retain the same behavior; the existing training simulation and Pact inventory remain the evidence. |

All of these are the same edit, applied across 58 draft proofs at once. Each
ships a `data-models/proof.proto` declaring `message ProofIdentity { string
slug = 1; string layer = 2; }` beside a `proof.cue` that defined a bare
anonymous `slug`/`layer` record — a record with no name to tie it to the
message it is supposed to constrain, which is what `architecture:guard`
reports as `missing-cue-constraints`. The record is now the named definition
`#ProofIdentity`, embedded at top level so the file still reads as the same
concrete data.

One constraint changed with it: `slug: string` became `slug: string & !=""`.
The old form restated proto3's declared type and refused nothing, so a proof
identifying itself with the empty string validated. Measured with cue v0.14.0,
old against new: `slug: ""` goes 0 → 1 and nothing else moves — a well-formed
record stays 0, `slug: 7` stays 1, `layer: "ux"` stays 1.

No disposition, evidence path, Linear link, or acceptance claim in the table
above moves. No proof in this epic identifies itself with an empty slug, so
nothing that validated before stops validating.

## Cascade absorptions

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/generation-safety-gate-contract` | latest validated leaf hardening | Safety-gate simulation and Pact evidence unchanged. |
| `src/draft/technical-proofs/generation-validation-stage-contract` | latest validated leaf hardening | Validation-stage simulation and replay evidence unchanged. |
| `src/draft/technical-proofs/human-approval-generation-gate-contract` | latest validated leaf hardening | Approval-required behavior and safety evidence unchanged. |

## Adversarial Scope Review

| Review area | Decision |
|---|---|
| Requirement proven | The POCs jointly prove a contract-first generation loop, a bounded training/eval promotion loop, and a gated live-fix propagation loop. |
| Unsafe details discarded | Prompt/material authority, live network access, unbounded repair, self-approval, raw sensitive trajectory payloads, and silent source mutation are excluded. |
| Contract strategy | Every boundary is represented by a consumer-side Pact fixture and mocked provider. Provider verification is deferred until real services exist. |
| Simulation risk | The simulation does not claim production readiness; it demonstrates architecture shape and fail-closed behavior with deterministic fixtures. |
| Active epic conflict | The reference implementation is isolated under the Generation epic slug and does not touch other epic reference paths. |
| Follow-up split | Provider-side Pact verification and live service adapters remain follow-up work outside this reference PR. |

| `src/draft/technical-proofs/openinference-trajectory-capture-contract` | latest validated leaf hardening | Trajectory capture and generation safety evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/slsa-provenance-certification-contract` | final validated leaf hardening | Generation, training, and safety evidence unchanged. |
