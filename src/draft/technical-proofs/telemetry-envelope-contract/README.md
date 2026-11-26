# Telemetry Envelope Boundary Contract POC

Independent POC for HOBO-104. It pins the M0 telemetry envelope and boundary-export schema that
Reliability, Observability, Cost, Run Inspector, SLO, alerting, metering, and audit projections
consume.

## Contract Surface

- `EventEnvelope` is versioned as `hobo.telemetry-envelope/v1`.
- Every envelope carries a W3C `meta.traceparent`.
- Boundary export is versioned as `hobo.boundary-export/v1`.
- OTLP spans carry the trace id/span id from `traceparent` plus a raw canonical envelope attribute.
- CloudEvents export keeps the internal event type as the CloudEvents `type`, with HoBo ordering and
  causation fields preserved through extensions/raw canonical envelope data.
- OCSF authorization export carries security-relevant audit fields (`principalRef`, `action`,
  `resource`, `decision`) and the raw canonical envelope.

## Guardrails

The POC proves the adversarial cases from the issue:

- Malformed `traceparent` fails closed; missing `traceparent` fails by default and can synthesize an
  explicit root only when requested.
- Event-family names stay fully qualified at export boundaries, so `run.Started` and `actor.Started`
  do not collide.
- CloudEvents imports reject missing required attributes.
- OCSF authorization export rejects a policy decision that would drop a security-relevant field.
- Schema-version or required-field changes fail compatibility checks.

## Scope Boundaries

Included:

- Canonical schema and validation for the internal telemetry envelope.
- Deterministic serialization helpers for contract fixtures.
- Boundary projection helpers for OTLP, CloudEvents, and OCSF round-trip proof.

Excluded:

- Actual OTLP exporter wiring.
- SLO, cost, or alert routing semantics.
- SIEM delivery, retention, or erasure behavior beyond the boundary event shape.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\telemetry-envelope-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Telemetry Envelope Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
