# S5-05 Forge Signing Registry Certification — Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-650.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Untrusted Forge certification-pass input is parsed once at the boundary into
derived domain types. Downstream consumers receive parsed types instead of
re-checking raw input.

## Event Architecture

- **Command** — `forge.CertifyAndPublish` after sandbox certification pass.
- **Event** — `gen.Certified` and `gen.PluginCertified` on successful publish.
- **Actor** — Forge certification registry aggregate.
- **Materialized view** — Registry listing available to Matching (not auto-selected).
- **Read store** — In-memory catalog seam models `packages/registry/`.

No runtime engine is implemented here; this is design-time contract evidence.
