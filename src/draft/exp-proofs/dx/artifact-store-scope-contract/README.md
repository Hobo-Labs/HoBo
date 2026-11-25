# Artifact Store Scope POC

HOBO-445 proof for Artifact Store M0 scope and acceptance.

## What This Proves

- Artifact Store has an explicit user/business goal and five primary personas.
- Artifact classes, custody states, required evidence fields, and service/UX/security/support
  boundaries are machine-checkable.
- The scope record depends on Provenance & Retention, Release Engineering, Registry &
  Distribution, Package Cache, Capability Review & Approval, and Support Workflow without taking
  their implementation scope.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build a production blob store, lifecycle
worker, registry backend, package cache, signing-key system, release pipeline, UI, support
automation, customer-data snapshot store, or live debug collection.

## Verification

```powershell
corepack pnpm --prefix src\draft\exp-proofs\artifact-store-scope-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Artifact Store scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
