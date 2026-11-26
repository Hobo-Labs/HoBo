# S6-09 Operator Crew Yard Services — Architecture Evidence

Draft contract for HOBO-664. Carries architecture-guard evidence per
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records
  the package boundary.

## Parse, Don't Validate

Untrusted scenario input is parsed once at the boundary into derived domain
types (`CrewPrincipal`, `SloBreachSignal`, `RemediationPlan`). Downstream
logic receives parsed types only; CUE constraints reject malformed input at
parse time.

## Event Architecture

Each operator run is an actor on stream `crew:<agentId>:<runId>`:

- **Command** — `DispatchOperator`, `ProposeRemediation`, `ApplyRemediation`.
- **Event** — `crew.AgentDispatched`, `crew.ActionProposed`,
  `crew.ActionApplied`, `crew.ActionDenied`, `policy.Decided`,
  `credential.AuditRecorded`, `guardrail.Blocked`.
- **Actor** — one Crew member service per principal.
- **Materialized view** — `CredentialAuditView` and `AgentActivityView` fold
  crew + credential events for dashboard replay.

No runtime engine is implemented here; this names the seams for production
promotion into `packages/sdk` and `packages/agent-skills`.
