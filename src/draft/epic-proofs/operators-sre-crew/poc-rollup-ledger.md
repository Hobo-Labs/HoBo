# POC Rollup Ledger

Epic: Operators & SRE - the Crew

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| hobo-remediation-action-contract | `src/draft/technical-proofs/hobo-remediation-action-contract` | HOBO-251 | SRE operator | Provider degradation is remediated through gated canary | detect-diagnose-gate-remediate | policy engine, remediation gateway | sre-policy-engine, sre-remediation-gateway | verified | implemented_in_reference_impl | Kept safety envelope and canary effect, discarded production action registry. |
| crew-event-contract | `src/draft/technical-proofs/crew-event-contract` | HOBO-254 | SRE operator | All actions are replayable Crew facts | all slices | projection read API, policy engine | sre-projection-read-api, sre-policy-engine | verified | implemented_in_reference_impl | Kept `crew.actionProposed`, `crew.actionApplied`, and handoff facts. |
| incident-aggregate-contract | `src/draft/technical-proofs/incident-aggregate-contract` | HOBO-258 | SRE operator | Multiple operational signals fold into one incident | all incident slices | projection read API, issue tracker | sre-projection-read-api, sre-issue-tracker | verified | implemented_in_reference_impl | Kept incident lifecycle and replay hash evidence; latest technical-proof change reconciled without changing the simulation. |
| runbook-contract | `src/draft/technical-proofs/runbook-contract` | HOBO-260 | SRE operator | High 5xx runbook selects bounded remediation | detect-diagnose-gate-remediate | projection read API, policy engine, remediation gateway | sre-projection-read-api, sre-policy-engine, sre-remediation-gateway | verified | implemented_in_reference_impl | Kept trigger-diagnose-fix shape, deferred full authoring DSL. |
| autonomous-action-safety-rail-model | `src/draft/technical-proofs/autonomous-action-safety-rail-model` | HOBO-263 | SRE operator | Unsafe writes require approval or deny | fail-closed-escalate | policy engine, A2H notifier | sre-policy-engine, sre-a2h-notifier | verified | implemented_in_reference_impl | Kept blast radius, reversibility, environment, self-causation checks. |
| failure-taxonomy-safe-fix-classifier | `src/draft/technical-proofs/failure-taxonomy-safe-fix-classifier` | HOBO-267 | SRE operator | Provider-degraded, contract-skew, and unknown classes choose different branches | all slices | projection read API, policy engine | sre-projection-read-api, sre-policy-engine | verified | implemented_in_reference_impl | Kept taxonomy outcomes, simplified classifier implementation for reference harness. |
| sre-operator-skeleton-contract | `src/draft/technical-proofs/sre-operator-skeleton-contract` | HOBO-270 | SRE operator | Signals dispatch SRE and open one incident | all slices | projection read API, issue tracker | sre-projection-read-api, sre-issue-tracker | verified | implemented_in_reference_impl | Kept dispatch skeleton, avoided production operator runtime. |
| endpoint-monitor-operator-contract | `src/draft/technical-proofs/endpoint-monitor-operator-contract` | HOBO-272 | SRE operator | Endpoint monitor emits SLO burn into SRE | provider-degraded-api | SLO signal source, projection read API | endpoint-monitor-slo-signals, sre-projection-read-api | verified | implemented_in_reference_impl | Kept SLO burn signal and credential-audit boundary as mock. |
| sre-diagnose-projection-contract | `src/draft/technical-proofs/sre-diagnose-projection-contract` | HOBO-276 | SRE operator | SRE reads diagnosis before action | all diagnostic slices | projection read API | sre-projection-read-api | verified | implemented_in_reference_impl | Kept read-only diagnosis and stale-projection fail-closed rule. |
| sre-decision-tree-contract | `src/draft/technical-proofs/sre-decision-tree-contract` | HOBO-280 | SRE operator | SRE chooses auto, propose, or escalate | all slices | projection read API, policy engine, A2H notifier | sre-projection-read-api, sre-policy-engine, sre-a2h-notifier | verified | implemented_in_reference_impl | Kept decision tree as scenario router. |
| gated-autonomous-remediation-contract | `src/draft/technical-proofs/gated-autonomous-remediation-contract` | HOBO-284 | SRE operator | Policy gate precedes live-fix canary | provider-degraded-api, prod-contract-skew | policy engine, remediation gateway | sre-policy-engine, sre-remediation-gateway | verified | implemented_in_reference_impl | Kept canary and approval obligations, deferred live rollout engine. |
| runbook-execution-engine-contract | `src/draft/technical-proofs/runbook-execution-engine-contract` | HOBO-285 | SRE operator | Runbook selects safe fix or escalation | provider-degraded-api, ambiguous-runaway-remediation | projection read API, policy engine | sre-projection-read-api, sre-policy-engine | verified | implemented_in_reference_impl | Kept engine contract behavior, mocked StackStorm-style provider. |
| on-call-escalation-contract | `src/draft/technical-proofs/on-call-escalation-contract` | HOBO-289 | SRE operator | Human-in-the-loop handoff notifies on-call | prod-contract-skew, ambiguous-runaway-remediation | A2H notifier | sre-a2h-notifier | verified | implemented_in_reference_impl | Kept obligation deadline and handoff package; latest technical-proof change reconciled without changing the simulation. |
| autonomous-drift-remediation-contract | `src/draft/technical-proofs/autonomous-drift-remediation-contract` | HOBO-292 | SRE operator | Drift with ambiguous causation escalates | detect-fail-closed-escalate | projection read API, policy engine, A2H notifier | sre-projection-read-api, sre-policy-engine, sre-a2h-notifier | verified | implemented_in_reference_impl | Kept drift input and repeated-drift escalation, did not implement reconciler internals; refreshed for the latest technical-proof change, with simulation and Pact evidence unchanged. |
| human-operator-console-contract | `src/draft/technical-proofs/human-operator-console-contract` | HOBO-294 | SRE operator | Approval snapshot gates production contract-skew remediation | diagnose-propose-approve-remediate | A2H notifier, remediation gateway | sre-a2h-notifier, sre-remediation-gateway | verified | implemented_in_reference_impl | Kept approval snapshot hash and RBAC intent, no frontend surface. |
| operator-integration-ports-contract | `src/draft/technical-proofs/operator-integration-ports-contract` | HOBO-297 | SRE operator | Incident sync and postmortem publication use ports | provider-degraded-api, ambiguous-runaway-remediation | issue tracker, knowledge base | sre-issue-tracker, sre-knowledge-base | verified | implemented_in_reference_impl | Kept port shape and adapter-swap constraint. |
| chaos-experiment-orchestration-contract | `src/draft/technical-proofs/chaos-experiment-orchestration-contract` | HOBO-298 | SRE operator | Chaos findings feed bounded SRE remediation | contract boundary only | sandbox fault injector | chaos-fault-injector | contracted | integrated | Kept bounded chaos contract. No live experiment in simulation. |
| disaster-recovery-failover-contract | `src/draft/technical-proofs/disaster-recovery-failover-contract` | HOBO-302 | SRE operator | Region loss runbook prepares failover | dr-fence-replay-failover | policy engine, replicated event log | sre-policy-engine, dr-replicated-event-log | verified | implemented_in_reference_impl | Kept failover approval and replicated log dependency. |
| sre-mttd-mttr-postmortem-contract | `src/draft/technical-proofs/sre-mttd-mttr-postmortem-contract` | HOBO-305 | SRE operator | Resolved incidents publish replay-backed postmortems | provider-degraded-api, regional-dr-failover | issue tracker, knowledge base | sre-issue-tracker, sre-knowledge-base | verified | implemented_in_reference_impl | Kept MTTD/MTTR and postmortem-as-replay evidence. |
| runaway-remediation-guard-contract | `src/draft/technical-proofs/runaway-remediation-guard-contract` | HOBO-308 | SRE operator | Self-caused follow-on drift opens a circuit | detect-fail-closed-escalate | policy engine, A2H notifier | sre-policy-engine, sre-a2h-notifier | verified | implemented_in_reference_impl | Kept cooldown and circuit breaker. |
| remediation-safety-gate-contract | `src/draft/technical-proofs/remediation-safety-gate-contract` | HOBO-313 | SRE operator | Provenance and risk checks decide remediation | all write slices | policy engine | sre-policy-engine | verified | implemented_in_reference_impl | Kept safety decision boundary, folded into policy engine contract. |
| dr-failover-integrity-contract | `src/draft/technical-proofs/dr-failover-integrity-contract` | HOBO-316 | SRE operator | Fencing, RPO, replay proof precede traffic shift | dr-fence-replay-failover | replicated event log, policy engine | dr-replicated-event-log, sre-policy-engine | verified | implemented_in_reference_impl | Kept integrity checks and interrupted failover resumability as follow-up. |
| sre-drift-remediation-journey-contract | `src/draft/exp-proofs/dx/sre-drift-remediation-journey-contract` | HOBO-216 | SRE operator via CLI/MCP user story | Drift remediation is visible through CLI/MCP | journey evidence only | projection read API, policy engine | sre-projection-read-api, sre-policy-engine | not_started | deferred | Cross-epic journey evidence. Kept as persona input, not rolled into this epic implementation. |
| slo-as-code-contract | `src/draft/technical-proofs/slo-as-code-contract` | HOBO-277 | SRE operator | SLO definitions feed operator decisions | boundary evidence only | SLO signal source | endpoint-monitor-slo-signals | not_started | out_of_scope_for_this_epic | Reliability epic owns SLO authoring. This rollup consumes SLO burn as a mocked boundary. |
| slo-computation-engine-contract | `src/draft/technical-proofs/slo-computation-engine-contract` | HOBO-277 | SRE operator | SLO burn calculation triggers monitor signal | boundary evidence only | SLO signal source | endpoint-monitor-slo-signals | not_started | out_of_scope_for_this_epic | Computation engine remains Reliability-owned. |
| alertmanager-routing-contract | `src/draft/technical-proofs/alertmanager-routing-contract` | HOBO-281 | SRE operator | Alert routing can notify SRE/on-call | boundary evidence only | A2H notifier | sre-a2h-notifier | not_started | out_of_scope_for_this_epic | Routing provider remains Reliability-owned; this rollup contracts notify consumption. |
| policy-engine-port-contract | `src/draft/technical-proofs/policy-engine-port-contract` | HOBO-100 | SRE operator | Policy gate returns allow, require approval, or deny | all write slices | policy engine | sre-policy-engine | not_started | out_of_scope_for_this_epic | Policy engine implementation remains Contracts/Policy-owned; this rollup consumes it. |
| delivery-orchestrator-skeleton-contract | `src/draft/technical-proofs/delivery-orchestrator-skeleton-contract` | HOBO-141 | SRE operator | Remediation applies through delivery/live-fix gateway | provider-degraded-api, prod-contract-skew | remediation gateway | sre-remediation-gateway | not_started | out_of_scope_for_this_epic | Harness delivery owns orchestrator internals. |
| policy-gated-flag-flips-contract | `src/draft/technical-proofs/policy-gated-flag-flips-contract` | HOBO-141 | SRE operator | Risky mutations are policy gated | boundary evidence only | policy engine, remediation gateway | sre-policy-engine, sre-remediation-gateway | not_started | out_of_scope_for_this_epic | Progressive Delivery owns flag-flip mechanics. |

## Cascade absorptions

Changes to referenced experience proofs that this rollup has taken in.

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/exp-proofs/dx/sre-drift-remediation-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/technical-proofs/endpoint-monitor-operator-contract` | Restored the nullish defaults the anti-slop sweep stripped, which had left the leaf crashing on omitted optional fields (`input.burnThreshold`, signal payload) | SLO burn signal and credential-audit evidence unchanged; simulation unchanged. |

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
| `src/draft/technical-proofs/disaster-recovery-failover-contract` | latest validated leaf hardening | DR failover replay and approval evidence unchanged. |
| `src/draft/technical-proofs/dr-failover-integrity-contract` | latest validated leaf hardening | Failover-integrity evidence and refusal paths unchanged. |
| `src/draft/technical-proofs/gated-autonomous-remediation-contract` | latest validated leaf hardening | Remediation gate and canary evidence unchanged. |

| `src/draft/technical-proofs/policy-gated-flag-flips-contract` | latest validated leaf hardening | Operator policy-gating and rollback evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/runbook-execution-engine-contract` | final validated leaf hardening | Runbook execution evidence unchanged. |
| `src/draft/technical-proofs/sre-diagnose-projection-contract` | final validated leaf hardening | SRE diagnosis evidence unchanged. |
| `src/draft/technical-proofs/sre-mttd-mttr-postmortem-contract` | final validated leaf hardening | Incident postmortem evidence unchanged. |
| `src/draft/technical-proofs/sre-operator-skeleton-contract` | final validated leaf hardening | Operator workflow evidence unchanged. |
