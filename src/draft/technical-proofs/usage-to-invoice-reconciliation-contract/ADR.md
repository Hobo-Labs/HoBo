# Usage-To-Invoice Reconciliation Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the parse, don't validate discipline: untrusted usage
evidence is parsed once at the contract boundary into derived domain types, and
downstream reconciliation functions consume parsed records instead of raw DTOs.
CUE constraints describe the same derived types so malformed usage events,
line-item mappings, privacy rules, and audit records are rejected at parse time.

## Event Architecture

The accepted contract is the read model behind a small event flow:

- Command - record accepted usage-to-invoice reconciliation evidence.
- Event - append `meter.UsageRecorded`, `support.UsageCorrectionApproved`, and
  `support.DisputeOpened` facts to the event store.
- Actor - the billing evidence aggregate folds usage, correction, duplicate,
  and dispute events in deterministic order.
- Event store - source usage facts and support decisions remain append-only.
- Materialized view / projection - a reconciliation projection emits
  invoice-adjacent line items and support audit lineage.
- Snapshot - the invoice evidence packet is a period-scoped snapshot of that
  projection.
- Read store - billing/support surfaces query the redacted read store, not raw
  usage payloads.

No runtime projector, billing service, provider integration, tax engine, or
payment processor is implemented here.
