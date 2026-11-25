# Registry Artifact Descriptor Contract POC

This POC pins the M0 `registry.descriptor/v1` contract for HOBO-331.

It defines:

- Listing-kind taxonomy: provider, Resource Pack, policy pack, agent skill, runbook, Hobo Code module, Bindle, Camp, Yard, and Junction.
- Digest-only artifact references for the listed artifact, SLSA provenance, and conformance reports.
- Declared WIT imports/exports as `interface@semver@stability` strings with per-interface conformance-suite evidence.
- A JSON Schema artifact, ESM validation helpers, TypeScript declarations, and round-trip fixtures.

Scope intentionally stops before OCI storage/transport, signature generation, discovery indexing, version resolution, and CLI behavior. Those remain separate slices.

## Verification

Run the focused contract suite:

```bash
npm.cmd --prefix src\draft\technical-proofs\registry-artifact-descriptor-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Registry Artifact Descriptor Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
