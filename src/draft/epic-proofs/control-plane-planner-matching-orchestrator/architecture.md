# Control Plane Architecture Rollup

The selected epic owns the Yard's deploy path from manifest intake through replayable planning, deterministic matching, event-sourced orchestration, resource reconciliation, drift repair, and self-host bootstrap. The reference implementation synthesizes the POCs into four vertical slices:

| Vertical slice | Persona | Reference behavior | POCs integrated |
|---|---|---|---|
| Deterministic planning and matching | Platform engineer | Manifest resources become a content-addressed DeploymentPlan DAG with match.Decided, capability feedback, mapping-sugar lowering, region objective scoring, and catalog hashes. | HOBO-39, HOBO-41, HOBO-45, HOBO-47, HOBO-55, HOBO-61, HOBO-64, HOBO-78, HOBO-81, HOBO-82, HOBO-86 |
| Delta-to-Set reconciliation | Release manager | Approved Deltas create immutable Sets; ResourceActors reconcile only changed nodes through mocked Executor and Driver boundaries. | HOBO-50, HOBO-68, HOBO-72, HOBO-73, HOBO-95, HOBO-97, HOBO-103, HOBO-109 |
| Safety and recovery | SRE operator | Drift refresh, orphan sweep, partial-realize rollback, compensation, dispatcher reservations, and DeploymentView correlation fail closed. | HOBO-363, HOBO-366, HOBO-369, HOBO-373, HOBO-376, HOBO-379, HOBO-382 |
| Self-host bootstrap | DevOps platform owner | A local seed Yard self-deploys the real Yard with one operator credential, imports provenance, hands over to real Identity, and blocks duplicate bootstrap. | HOBO-59, HOBO-359 |

## Boundary Model

The reference implementation treats each external or cross-module dependency as a mocked service boundary with a Pact fixture. Provider absence is documented instead of hidden.

| Boundary | Why it exists | Runtime in simulation |
|---|---|---|
| Manifest collector | Planner consumes manifest IR produced by SDK/IfC collection. | Fixture-backed manifest response |
| Resource Definition catalog | Matching must use a stable catalog snapshot. | Fixture-backed catalog and hash |
| Capability registry | `require`/`prefer` negotiation must reject unsupported capabilities. | Fixture-backed support matrix |
| Objective ledger | Region/objective and Dispatcher choices must use pinned inputs. | Fixture-backed CreditLedgerView |
| Gatekeeper | Delta/Set and apply gates need contract/policy/eval decisions. | Fixture-backed allow/deny decisions |
| Deployment Set store | Deltas and Sets are immutable projection boundaries. | Fixture-backed Set refs |
| EventStore and ActorHost | ResourceActors need single-writer replayable state. | In-memory event fixture |
| Executor sandbox | IaC/build work must run without ambient credentials. | Firecracker-shaped mock |
| Driver adapter | Resource Definitions dispatch to driver taxonomy. | Terraform/template/echo/container/webhook mock |
| Drift refresh provider | Reconcile loop is level-triggered by refresh evidence. | Fixture drift response |
| Identity token broker | Executors receive scoped short-lived tokens. | Redacted token descriptor |
| Bootstrap handover | Seed Yard must hand over to real Identity explicitly. | Fixture handover transcript |
| DeploymentView projection | Choreography needs read-model reconstruction. | Fixture correlation graph |

## What Was Kept

- Pure Planner function, content-addressed plan output, and exact event vocabulary.
- Specificity-ranked Matching with stable tiebreak and catalog hash.
- Capability negotiation as both author-time feedback and deploy-time rejection.
- Delta-to-Set lifecycle and incremental ResourceActor reconcile.
- Choreography, not central step orchestration, for dependency activation and rollback.
- Executor sandbox with no ambient credentials.
- Drift refresh and orphan sweep as normal reconcile inputs.
- Dispatcher reservation CAS for double-spend safety.
- Self-host seed ordering and explicit Identity handover.

## What Was Revised

- POC-local code is represented as synthesized reference behavior, not copied as product packages.
- Provider/IaC details are mocked at the boundary instead of pretending production adapters exist here.
- DeploymentView is kept as evidence reconstruction, not a dashboard.
- Adopt-in-place is represented by lifecycle decisions and drift-detect-only constraints, not a `hobo import` CLI.

## Deferred or Out of Scope

- Live clouds, provider SDKs, Pulumi/OpenTofu/Crossplane execution, Firecracker execution, production EventStore, real Identity, real Gatekeeper, and real Registry.
- Provider package implementation belongs to the Providers/IaC epic.
- CLI/MCP verbs and dashboards belong to the CLI/DX epic.
- Networking Relay runtime belongs to the Networking epic.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
