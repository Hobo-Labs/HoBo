# S4-08 Portability Conformance Lane — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

Untrusted conformance evidence is parsed once at the lane boundary into **parsed types** and
**derived domain types** (`PortabilityConformanceReport`, workspace edge classifications). Downstream
CI consumers receive those parsed types instead of re-checking raw fixture bytes.

## Event Architecture

- **Command** — `RunNfr001PortabilityLane` with multi-cloud-shop evidence.
- **Event** — `conformance.Nfr001PortabilityLanePassed` or `deployment.PlanRejected`.
- **Actor** — the conformance lane aggregate owns pass/fail disposition.
- **Event store** — accepted conformance events append to the platform event store.
- **Materialized view / projection** — the lane report projection folds events into the query surface.
- **Snapshot** — the accepted report is the snapshot of that projection.
- **Read store** — downstream CI and stage gates query the read store rather than the raw event log.

This draft package applies the **parse, don't validate** discipline: untrusted input crosses one
parser boundary and becomes parsed derived domain types before any conformance assertion runs.
