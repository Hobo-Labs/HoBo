# @hobo-draft/bindles-resource-catalog

> **Promoted to `packages/bindles/` (S1-13 / HOBO-602).** Production implementation lives in `@hobo/bindles`; this draft proof remains as the HOBO-37 reference.

POC for HOBO-37: the `@hobo/bindles` resource catalog declaration surface.

This draft package proves the M0 contract before generated `hobo:sdk` bindings exist:

- every resource row in [`docs/design/authoring-resources-wiring.md`](../../../../docs/design/authoring-resources-wiring.md#catalog--resource--wit-port--permission-verbs) has exactly one exported catalog factory;
- each handle records stable identity, `portRef`, and the type marker for its `.allow()` verbs;
- verb methods return inert descriptors that explicitly lower to future generated `hobo:sdk` bindings;
- `secret()` and `secretRef()` are distinct symbols;
- `search` remains a query-side `data(...).query(...)` capability, not a catalog factory.

Out of scope for this POC: collection, manifest emission, provider options, topology objects, codegen, and authoring new WIT.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Bindles Resource Catalog.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
