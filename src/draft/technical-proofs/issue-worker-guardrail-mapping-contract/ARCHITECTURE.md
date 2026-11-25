# Issue-Worker Guardrail Mapping Contract Architecture

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Automation guardrail mapping is parsed once by `assertIssueWorkerGuardrailMapping`
into a derived `IssueWorkerGuardrailMappingRecord`. Downstream checks consume
that parsed record and do not accept broad raw doc text with repeated boolean
checks.

## Event Architecture

- **Command** — `ValidateIssueWorkerGuardrailMapping`.
- **Event** — `automation.GuardrailMappingAccepted`.
- **Actor** — the automation-spec actor owns the mapping record.
- **Projection** — `docs/automations/hobo-issue-worker.md` consumes the accepted
  mapping snapshot.
- **Snapshot** — this proof package and Pact fixture are the current review
  snapshot.

No issue-worker runtime, Linear integration, or GitHub automation is
implemented here.
