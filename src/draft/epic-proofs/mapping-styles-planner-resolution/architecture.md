# Mapping Styles + Planner Resolution — architecture evidence

HOBO-640 draft epic proof. Parse-don't-validate at camp mapping compile and capability negotiation boundaries; event-driven plan outcomes (`deployment.Planned`, `deployment.PlanRejected`, `match.Decided`).

## Boundaries

- **Camp mapping sugar** — `defaultProvider`, `tiers`, `bindings` lower to Resource Definitions (`camp-mapping-sugar-compiler`).
- **Capability negotiation** — `prefer`/`require` against provider Capability Manifest fixtures (`capability-negotiation-contract`).
- **Topology objects** — programmatic `bindle` / `camp` / `yard` (`topology-objects-contract`).
- **Provider options** — `.with(...)` annotations inert for non-resolved providers (`provider-options-pattern-contract`).

## Events

- Successful multi-resource plan → `deployment.Planned` with `plan.rationale` and per-resource `match.Decided` evidence.
- Hard `require` miss → `deployment.PlanRejected` with `capability.require.unsatisfied` reason (fixture-stable).

## Guardrail evidence

Parse, don't validate: camp mapping configs, capability manifest fixtures, and port `require`/`prefer` requests cross parser boundaries (`compileCampMapping`, `decideCapabilityNegotiatedDefinition`, `validateControlPlaneEvent`) before the planner uses them. Parsed derived types are `CampObject`, `PlannerResolution`, and `CapabilityManifest` records; core functions accept only those derived domain types, not raw mapping DTOs.

Event architecture: `planCampDeployment` is the command handler for `cmd-plan:*`; the Planner actor emits `match.Decided` per resource and either `deployment.Planned` or `deployment.PlanRejected` into the fixture event-store. Materialized views/projections rebuild `DeploymentPlan` rationale from the event stream; snapshots capture the current plan per camp, and historical snapshots are retained in a read store so acceptance tests replay planner outcomes without mutating provider fixtures.
