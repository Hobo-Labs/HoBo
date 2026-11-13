# Progressive Delivery Harness POC Rollup Ledger

Selected epic: Progressive Delivery - The Harness (`122f5e0a-30d6-4949-9285-9441d18c36d9`)

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| DevOps canary rollout journey | `src/draft/exp-proofs/dx/devops-canary-rollout-journey-contract` | HOBO-224 | DevOps operator | `hobo up --strategy canary` reaches 10/50/100 or auto-rolls back | End-to-end progressive release simulation | CLI journey, delivery, SLO, traffic split, event stream | `pact-harness-traffic-split.json`, `pact-harness-slo-telemetry.json`, `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept journey shape and inspect/log audit stream; no CLI product code copied. |
| Feature-flag port | `src/draft/technical-proofs/hobo-feature-flag-port` | HOBO-299 | App operator | Feature flag evaluates deterministic treatment/default value | Feature flag leg | Harness to feature-flag provider | `pact-harness-flag-provider.json` | verified | implemented_in_reference_impl | Kept OpenFeature-shaped detailed evaluation and fail-safe defaulting. |
| Delivery port | `src/draft/technical-proofs/hobo-delivery-port` | HOBO-301 | Platform operator | Delivery provider emits rollout lifecycle events | Delivery leg | Harness to delivery provider and event stream | `pact-harness-traffic-split.json`, `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept lifecycle event vocabulary; no production provider adapter. |
| Experiment port | `src/draft/technical-proofs/hobo-experiment-port` | HOBO-304 | Growth engineer | Assignment, exposure, and conclusion events stay typed | Experiment leg | Harness to experiment analytics provider | `pact-harness-experiment-analytics.json` | verified | implemented_in_reference_impl | Absorbed the validated contract-hardening update; kept event and definition vocabulary with no vendor adapter. |
| Flag event contract | `src/draft/technical-proofs/flag-event-contract` | HOBO-310 | App operator | Flag change records replayable actor-scoped event | Flag event stream | Harness to event stream | `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept `flag.Changed`/`flag.Evaluated` audit stream. |
| SLO promotion gate | `src/draft/technical-proofs/slo-promotion-gate-contract` | HOBO-314 | Platform operator | Healthy pinned SLO promotes; stale/unavailable SLO holds | Promotion gate | Harness to Reliability SLO snapshot provider | `pact-harness-slo-telemetry.json` | verified | implemented_in_reference_impl | Kept pure gate over pinned `snapshot@seq`; SLO computation stays out of scope. |
| Built-in flag store | `src/draft/technical-proofs/built-in-flag-store-contract` | HOBO-319 | App operator | Offline store evaluates `(ruleset@seq, context)` reproducibly | Flag store default | Harness to flag store | `pact-harness-flag-provider.json` | verified | implemented_in_reference_impl | Kept deterministic in-process behavior with no network fetch. |
| SDK flag surface | `src/draft/technical-proofs/sdk-flag-surface-contract` | HOBO-323 | App developer | `ctx.flags` and `useFlag` consume flag state | SDK ergonomics | SDK to flag provider | none | not_started | deferred | Useful consumer ergonomics, but the epic reference targets the Harness runtime boundary, not SDK API shape. |
| Flag ruleset sync | `src/draft/technical-proofs/flag-ruleset-sync-contract` | HOBO-326 | App operator | Reconnect rebuilds from snapshot plus tail without regression | Ruleset sync | Harness to Streamer/event log | `pact-harness-ruleset-sync.json` | verified | implemented_in_reference_impl | Kept stale label and monotonic seq behavior. |
| Delivery orchestrator skeleton | `src/draft/technical-proofs/delivery-orchestrator-skeleton-contract` | HOBO-328 | Platform operator | Rollout replay resumes without duplicate steps | Delivery orchestration | Harness to delivery provider, event stream, policy gate | `pact-harness-traffic-split.json`, `pact-harness-event-stream.json`, `pact-harness-policy-gate.json` | verified | implemented_in_reference_impl | Kept event-sourced state machine and fail-closed gates. |
| Preview ephemeral environments | `src/draft/technical-proofs/preview-ephemeral-environments-contract` | HOBO-332 | App reviewer | Pull request opens isolated preview Camp | Preview environment | Harness to Matching/provider drivers | none | not_started | deferred | Adjacent to Harness, but not needed to prove release safety for this epic rollup. |
| Canary/blue-green/progressive saga templates | Delivery POCs | HOBO-337 | Platform operator | Canary steps advance through declared percentages | Delivery strategy | Harness to traffic split provider | `pact-harness-traffic-split.json` | verified | implemented_in_reference_impl | Represented by 10/50/100 canary simulation; blue/green remains documented follow-up. |
| SLO-gated rollback analysis | `src/draft/technical-proofs/slo-gated-rollback-analysis-contract` | HOBO-342 | Platform operator | SLO burn creates auto-revert obligation and rollback signal | Metric gate | Harness to SLO telemetry and policy obligations | `pact-harness-slo-telemetry.json`, `pact-harness-policy-gate.json` | verified | implemented_in_reference_impl | Kept burn/hold/rollback decisions and auto-revert obligation lifecycle. |
| Policy-gated flag flips | `src/draft/technical-proofs/policy-gated-flag-flips-contract` | HOBO-345 | SecOps reviewer | Risky prod flag flip requires policy decision before stream commit | Flag governance | Harness to policy plane and event stream | `pact-harness-policy-gate.json`, `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept policy-gated `flag.Changed` before commit. |
| OpenExperiment runtime data | `src/draft/technical-proofs/openexperiment-runtime-data-contract` | HOBO-349 | Growth engineer | Assignment and exposure are sticky and traceable | Experiment runtime | Harness to event stream and analytics | `pact-harness-experiment-analytics.json`, `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept sticky assignment and idempotent exposure behavior. |
| Experiment statistical analysis | `src/draft/technical-proofs/experiment-statistical-analysis-contract` | HOBO-353 | Growth engineer | Guarded analysis ships only powered, scheduled wins | Experiment analysis | Harness to experiment analytics provider | `pact-harness-experiment-analytics.json` | verified | implemented_in_reference_impl | Kept underpowered and p-hacking guardrails. |
| SLO-gated rollback correctness | Linear issue and rollback POCs | HOBO-356 | Platform operator | Auto rollback cannot strand split traffic | Delivery hardening | Harness to SLO telemetry, traffic split, rollback compensator | `pact-harness-slo-telemetry.json`, `pact-harness-traffic-split.json`, `pact-harness-rollback-compensation.json` | verified | implemented_in_reference_impl | Represented by SLO burn and failed rollback compensation scenarios. |
| OpenFeature provider adapters | `src/draft/technical-proofs/openfeature-provider-adapters-contract` | HOBO-361 | Platform operator | External flag providers pass same conformance | External flag adapters | Harness to vendor adapters | `pact-harness-flag-provider.json` | not_started | deferred | Contract shape is covered; no vendor SDK or credentials introduced. |
| Flag partition consistency | `src/draft/technical-proofs/flag-partition-consistency-contract` | HOBO-367 | App operator | Partitioned evaluator serves stale-labeled last-known ruleset | Flag sync hardening | Harness to ruleset sync | `pact-harness-ruleset-sync.json` | verified | implemented_in_reference_impl | Kept stale-not-fresh fail-closed behavior. |
| Stuck rollout convergence | `src/draft/technical-proofs/stuck-rollout-convergence-contract` | HOBO-372 | Platform operator | Non-converged split reaches terminal safe state | Delivery hardening | Harness to traffic split provider and event stream | `pact-harness-traffic-split.json`, `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept authoritative observed split and needs-human escalation. |
| Experiment p-hacking guardrails | `src/draft/technical-proofs/experiment-statistical-analysis-contract` | HOBO-375 | Growth engineer | Early or underpowered favorable look does not conclude | Experiment analysis | Harness to experiment analytics provider | `pact-harness-experiment-analytics.json` | verified | implemented_in_reference_impl | Integrated through underpowered scenario. |
| Rollback failure compensation | `src/draft/technical-proofs/rollback-failure-compensation-contract` | HOBO-378 | Platform operator | Failed compensation escalates with unsatisfied obligation | Rollback hardening | Harness to rollback compensator and event stream | `pact-harness-rollback-compensation.json`, `pact-harness-event-stream.json` | verified | implemented_in_reference_impl | Kept bounded retry and human handoff semantics. |
| Flag debt cleanup | `src/draft/technical-proofs/flag-debt-auto-cleanup-contract` | HOBO-381 | App operator | Stale flags are proposed for non-destructive archival | Flag lifecycle | Harness to flag store and code references | none | not_started | deferred | Lifecycle cleanup is not part of safe-release vertical slice. |
| Cross-Camp flag consistency | `src/draft/technical-proofs/cross-camp-flag-state-consistency-contract` | HOBO-384 | Multi-Camp operator | Follower reads carry bounded-staleness labels | Cross-Camp replication | Harness to replication stream | none | not_started | split_follow_up | Requires cross-Camp topology/replication reference, beyond this epic-local Harness slice; latest technical-proof change reconciled without changing this epic's out-of-scope disposition. |
| Delivery/experiment adapter conformance | `src/draft/technical-proofs/delivery-experiment-adapter-conformance-suite` | HOBO-387 | Platform operator | Delivery and experiment adapters satisfy the same suite | Adapter conformance | Harness to delivery and experiment adapters | `pact-harness-traffic-split.json`, `pact-harness-experiment-analytics.json` | verified | implemented_in_reference_impl | Kept conformance expectation through mocked provider verification. |

| Experiment statistical analysis | `src/draft/technical-proofs/experiment-statistical-analysis-contract` | HOBO-353 | Growth engineer | Guarded analysis ships only powered, scheduled wins | Experiment analysis | Harness to experiment analytics provider | `pact-harness-experiment-analytics.json` | verified | implemented_in_reference_impl | Latest leaf validation is absorbed; guardrail simulation unchanged. |

## Cascade absorptions

Changes to referenced experience proofs that this rollup has taken in.

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/exp-proofs/dx/devops-canary-rollout-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/technical-proofs/hobo-experiment-port` | latest validated leaf hardening | Assignment, exposure, and conclusion evidence unchanged. |

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

## Cascade absorptions (batch five)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/openexperiment-runtime-data-contract` | latest validated leaf hardening | Runtime-data and experiment evidence unchanged. |
| `src/draft/technical-proofs/policy-gated-flag-flips-contract` | latest validated leaf hardening | Flag-gating and rollout evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/sdk-flag-surface-contract` | final validated leaf hardening | SDK flag evidence unchanged. |
| `src/draft/technical-proofs/slo-gated-rollback-analysis-contract` | final validated leaf hardening | Rollback gate evidence unchanged. |
| `src/draft/technical-proofs/slo-promotion-gate-contract` | final validated leaf hardening | Promotion gate evidence unchanged. |
| `src/draft/technical-proofs/stuck-rollout-convergence-contract` | final validated leaf hardening | Rollout convergence evidence unchanged. |
