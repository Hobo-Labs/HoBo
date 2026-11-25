# HOBO-152 Codegen CLI Contract

This draft proves the wrapper contract for `hobo codegen` and `hobo codegen --check`.
It intentionally does not implement the production shared codegen engine. The POC
uses a fixture engine that reads the four authoritative sources named by ADR-0037:
WIT, Zod resource schemas, `.allow()` scopes, and the bindle graph.

## Proven Surface

- `hobo codegen` rewrites the documented generated layout: `.hobo/generated/` for
  the manifest and `src/_generated/` for checked-in TypeScript declarations.
- `hobo codegen --check` compares an in-memory regeneration against the working
  tree, reports path-level drift, and never mutates files.
- `hobo codegen --json` emits a CI-readable envelope with drift status.
- Source parse failures name the offending file and happen before any generated
  tree mutation.
- Non-TypeScript guests fail closed with a `static-analysis required` diagnostic.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-codegen-cli-contract test
```

Promoted to draft POC `src/draft/technical-proofs/s0-04-protobuf-cue-codegen/` (HOBO-581 / S0-04); production target is `packages/schema-tools/`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Codegen Cli Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
