# ADR: Vibe workspace/project state proof

## Status

Accepted for `HOBO-541`.

## Context

Workspace & Onboarding UX needs concrete state mockups before a production
dashboard or onboarding flow exists. The state surface must reuse HOBO-577
quickstart evidence and avoid inventing provider readiness, support behavior,
customer data, billing/auth/account behavior, or launch claims.

## Decision

Define `src/draft/exp-proofs/ux/vibe-workspace-project-states` as an executable
fixture contract for the six workspace/project states: empty, ready, blocked,
recovering, failed, and value-proven.

Raw fixture data crosses one parser boundary,
`parseVibeWorkspaceProjectStateModel`, and downstream mockups consume the parsed
state model. Each state carries owner, provider-readiness, safe next action,
evidence link, support handoff, accessibility notes, and wireframe regions.

This package applies parse, don't validate discipline: unknown workspace/project
fixture input is parsed once into the derived type
`VibeWorkspaceProjectStateModel`. Downstream mockup, support, and docs
consumers receive that derived type instead of re-checking raw fixture fields.
CUE constraints bind the same derived type so malformed state, owner, evidence,
proof-mode, handoff, or wireframe rows fail at the boundary.

## Architecture notes

- Commands: safe next actions are fixture actions only; no production UI or CLI
  command is introduced.
- Event behavior: provider-readiness and value evidence are represented by
  fixture evidence links, not runtime events.
- Actor behavior: owner roles are app developer, team admin, platform engineer,
  and support operator; no actor runtime is implemented.
- Event-store behavior: this proof does not append to an event-store; future
  onboarding runtime must persist accepted `workspaceProject.StateObserved` and
  `workspaceProject.EvidenceLinked` events before claiming live state.
- Materialized view / projection behavior: workspace/project states are modeled
  as projection rows over deterministic fixture evidence.
- Snapshot behavior: each fixture is a static snapshot with evidence freshness,
  proof mode, and safe next action.
- Read store behavior: downstream mockups may read store-shaped snapshots from
  this proof, but production read store persistence is out of scope.
- PACT/Protobuf/CUE: local architecture artifacts pin the fixture boundary.

## Consequences

Workspace mockups can show what is empty, ready, blocked, recovering, failed,
or value-proven without implying production readiness. Follow-on UI and support
work must keep proof-mode labels and cannot convert these fixtures into live
provider calls, customer-data surfaces, billing/auth/account flows, or launch
claims.
