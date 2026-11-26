# Broker Environment Publication Contract

Independent POC for HOBO-526.

This package proves that provider Capability Manifest evidence, catalog state, mapping
publication, approval metadata, version pins, and provenance can be parsed into an immutable
Broker Environment snapshot. Provider defaults are carried only as broker-validation inputs; the
snapshot does not make a final Yard placement decision.

The POC covers:

- approved provider/catalog/mapping publications producing a Broker Environment snapshot;
- approval metadata and provenance surviving into the snapshot;
- unapproved, stale, and incompatible publications failing closed;
- non-object or non-cloneable boundary input failing closed before downstream parsing;
- malicious provider claims that skip conformance or approval evidence being rejected; and
- shadow updates that change resolution inputs requiring a new snapshot identity.

## Verification

```powershell
pnpm --prefix src\draft\broker-environment-publication-contract test
```

## Architecture Evidence

- `architecture/` contains protobuf data shapes and CUE constraints for the publication boundary.
- `architecture/pacts/` contains the PACT-style consumer/provider fixture for publication.
- `ARCHITECTURE.md` records parse-don't-validate and event architecture evidence.

## Scope

This package does not implement provider adapters, marketplace publishing UX, hosted broker
runtime, Yard planner behavior, or live catalog sync. It only proves the Broker Environment
snapshot publication boundary needed by HOBO-526.

## Testing

Run `pnpm --filter @hobo-draft/broker-environment-publication-contract test`
(Vitest). The suite includes an architecture-evidence check that reads
[`ARCHITECTURE.md`](./ARCHITECTURE.md) alongside the protobuf, CUE, and PACT
fixtures and asserts the parse-don't-validate and event-sourcing boundary is
named.
