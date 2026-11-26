# Operators & SRE Crew Architecture

## Persona outcome

The SRE operator is a built-in Crew principal that reads observability and projection data, classifies incidents, proposes bounded remediations, and routes unsafe writes through policy and human obligations. The reference implementation keeps this as an event-sourced vertical slice rather than a production service.

## Boundary map

```mermaid
flowchart LR
  EM["Endpoint Monitor"] --> SLO["SLO signal source"]
  EM --> SRE["SRE operator"]
  SRE --> PROJ["Projection read API"]
  SRE --> POL["Policy engine"]
  SRE --> FIX["Remediation gateway"]
  SRE --> A2H["A2H notify receiver"]
  SRE --> ISSUE["Issue tracker port"]
  SRE --> KB["Knowledge port"]
  DR["DR runbook executor"] --> LOG["Replicated event log"]
  CHAOS["Chaos orchestrator"] --> FAULT["Sandbox fault injector"]
```

Every arrow has a contract fixture and a mock in the simulation. Missing production providers are treated as provider-unavailable contract decisions, not omitted boundaries.

## Design decisions preserved from POCs

- Incident lifecycle is a single event-sourced aggregate, not independent per-alert pages.
- Crew facts stay in `crew.*`; domain facts remain in `incident.*`, `policy.Decided`, `liveFix.*`, `runbook.*`, `chaos.*`, and DR event families.
- Write actions always pass through the policy boundary.
- Production and ambiguous changes require approval or handoff.
- Runaway remediation and self-causation fail closed.
- DR failover cannot shift traffic until fencing, RPO honesty, and replay proof are present.
- Issue tracker and knowledge systems are ports, not baked-in integrations.

## Deferred production work

- Real policy provider verification.
- Runtime ActorHost wiring for incident and runbook aggregates.
- Real MCP tools for operator console approval.
- PagerDuty/OpsGenie/Slack receiver adapters.
- Real live-fix gateway, chaos fault injector, and replicated event-log providers.
- HolmesGPT or StackStorm adapter conformance.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
