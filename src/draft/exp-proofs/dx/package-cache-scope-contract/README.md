# Package Cache Scope POC

HOBO-446 proof for Package Cache M0 scope and acceptance.

## What This Proves

- Package Cache has an explicit user/business goal and five primary personas.
- Cache subjects, required evidence fields, result states, and service/UX/security/support
  boundaries are machine-checkable.
- The scope record depends on artifact store, registry, release provenance, SBOM/vulnerability,
  bootstrap, security, and support records without taking their implementation scope.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build a production package cache, package
mirror, registry backend, installer, scanner, support automation, artifact store, offline bundle
builder, or live network package fetch.

## Verification

```powershell
corepack pnpm --prefix src\draft\package-cache-scope-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Package Cache scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
