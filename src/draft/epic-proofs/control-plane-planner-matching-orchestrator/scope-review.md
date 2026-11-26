# Adversarial Scope Review

## Decision

All 28 Control Plane child POCs are accepted into this epic reference implementation. Each is used as requirement evidence and contract-shape input, not copied as product code. Adjacent provider, identity, networking, CLI, and dashboard implementation details stay outside this epic.

| Question | Decision |
|---|---|
| Requirement proved | The Yard can plan, match, apply, reconcile, recover, and self-host through replayable events and mocked service boundaries. |
| Personas served | Platform engineer, release manager, SRE operator, and DevOps platform owner. |
| BDD scenarios | Deterministic plan, Delta-to-Set reconcile, drift/partial-realize recovery, and self-host handover. |
| Vertical slices | Planning/matching, reconciliation, safety/recovery, and bootstrap. |
| Boundaries crossed | Manifest collector, catalog, capability registry, objective ledger, Gatekeeper, Set store, EventStore/ActorHost, Executor, Driver adapter, Drift refresh, Identity broker, Bootstrap handover, DeploymentView. |
| Pact strategy | One consumer Pact fixture per boundary; provider verification marked provider-unavailable while providers are design-phase mocks. |
| Implementation ideas kept | Pure functions, content hashes, catalog hashes, explicit events, actor ordering from DAG, single-writer semantics, short-lived credential descriptors, fail-closed drift and dispatch decisions. |
| Accidental details discarded | POC-local helper APIs, package names, direct provider/IaC mocks that imply live support, and any CLI/dashboard surface. |
| Invalidated assumptions | A matching decision without catalog hash is not auditable; a rollback that only destroys recorded state misses created-but-not-in-state orphans; dispatch determinism is not reservation safety. |
| Edge/abuse cases | Unsupported `require`, true tie attribution, non-idempotent actor replay, ambient credentials, drift loops, orphan resources, duplicate bootstrap, concurrent credit spend, partial compensation failure. |
| Design conflicts | Providers/IaC owns concrete adapters; Identity owns real broker issuance; Networking owns Relay runtime; CLI/DX owns command UX. |
| Deferred or split | Live IaC adapters, real resource packs, real SVID tokens, real Relay sockets, and dashboard rendering. |
| Feature drift risk | Copying POC internals would turn design-phase evidence into product implementation outside the reference path. |
| Simulation risk | Any live provider, live token, or live registry call would make the harness misleading; fixtures are mandatory. |
| Contract brittleness risk | Pact fixtures assert boundary payload shape and compatibility decisions, not the full control-plane business workflow. |
| Active epic conflict | No active Control Plane rollup existed; Networking PR #420 and provider POC PRs remain untouched. |

## Scope-Out Checks

- No live external services.
- No product package under `src/` outside the common epic reference implementation root.
- No POC folder deletion.
- No completed child issue is marked Done by this run.
