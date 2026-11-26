# S5-05 Forge Signing Registry Certification — Architecture Evidence

Architecture-guard evidence for HOBO-650.

## Schema And Constraints

- Protobuf: [`architecture/s5_05_forge_signing_registry_certification_contract.proto`](./architecture/s5_05_forge_signing_registry_certification_contract.proto)
- CUE: [`architecture/s5_05_forge_signing_registry_certification_contract.cue`](./architecture/s5_05_forge_signing_registry_certification_contract.cue)
- PACT: [`architecture/pacts/s5_05_forge_signing_registry_certification_contract.pact.json`](./architecture/pacts/s5_05_forge_signing_registry_certification_contract.pact.json)

## Parse, Don't Validate

Untrusted Forge certification-pass input is parsed once at the boundary into derived domain types
for candidate, validation report, conformance report, and signed install candidate. Downstream
code receives parsed types instead of re-checking raw DTO fields.

## Event Architecture

- **Command** — `forge.CertifyAndPublish` after sandbox certification pass.
- **Event** — `gen.Certified` and `gen.PluginCertified` append on successful publish.
- **Actor** — Forge signing registry actor serializes certify-and-publish per provider coordinate.
- **Event store** — accepted certification events append to the platform event store.
- **Projection** — Registry catalog folds certification events into installable listings.
- **Materialized view** — certified provider listings available to Matching (not auto-selected).
- **Snapshot** — signed certification record is the snapshot of the registry projection.
- **Read store** — install and Matching surfaces query the catalog read store, not raw event log.

No runtime projector, KMS, or production Registry transport is implemented here.
