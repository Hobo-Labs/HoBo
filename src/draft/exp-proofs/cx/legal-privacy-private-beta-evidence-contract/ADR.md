# Legal Privacy Private Beta Evidence Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is
parsed once at the boundary into a derived private beta evidence record, and
downstream consumers receive that parsed record instead of re-checking raw
inputs. The CUE constraints bound the same derived types so malformed evidence,
speculative follow-ups, and unsupported claims are rejected at parse time rather
than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - record the M2 legal/privacy private beta evidence gate.
- **Event** - append `legalPrivacy.PrivateBetaEvidenceAccepted` when the gate
  passes.
- **Actor** - the V1 Legal, Privacy & Terms Readiness gate actor applies events
  in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - the release readiness projection folds the
  event stream into blockers, accepted risks, follow-ups, and owner handoffs.
- **Snapshot** - the accepted M2 evidence record is the snapshot of that
  projection.
- **Read store** - release cutline, support, customer assurance, and launch
  communications query the read store rather than raw evidence inputs.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
