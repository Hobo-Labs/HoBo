# ADR — S0-03 hobo-core draft POC

## Parse-don't-validate

This package follows **parse, don't validate**: untrusted JSON crosses exactly one parser per boundary and becomes **parsed derived types** that are deep-frozen.

- `parseEventEnvelope` → frozen `EventEnvelope` (`EnvelopeParseError` on failure)
- `parseCapabilityManifestBundle` → frozen `CapabilityManifestBundle` (`ManifestParseError` on failure)
- `createPortDescriptor` → frozen `PortDescriptor` (`PortDescriptorParseError` on failure)

Each parser throws a typed `CoreParseError` subclass carrying `path`, `expected`, `received`, and `code`.

## Event architecture

HoBo state transitions are **commands** that emit append-only **events** wrapped in `EventEnvelope`.
The **actor** field records who caused the event. Runtime slices own the **event store**, **materialized view** /
**projection** pipelines, **snapshot** persistence, and **read store** queries — this package defines only the envelope
contract those subsystems share.

| Concern | This package | Runtime slices |
|---|---|---|
| Command/event families | Envelope `type` (`family.PastTenseFact`) | Command handlers + append |
| Actor | `actor: PrincipalRef` | Actor host |
| Event store | Envelope shape only | Camp EventStore port |
| Materialized view / projection | Not implemented | Query projections |
| Snapshot / read store | Not implemented | Historical + current reads |
