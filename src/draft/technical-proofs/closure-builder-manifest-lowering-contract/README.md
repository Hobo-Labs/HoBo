---
type: Reference
title: "Closure Builder Manifest Lowering Contract"
description: "HOBO-535 proof for lowering closure-builder captures to hobo:sdk calls and hobo.manifest/v1."
tags: [hobo, proof]
---

# Closure Builder Manifest Lowering Contract

HOBO-535 proof for the closure-builder lowering seam.

## What This Proves

- Captured closure-builder resource facts lower to `hobo:sdk` calls and `hobo.manifest/v1`.
- Golden fixtures cover cache/API/queue dependency edges, inert workload descriptors, generated IDs,
  aliases, and provider `.with(...)` annotations.
- Deployment identity is the HoBo-generated resource ID. Returned aliases remain authoring and
  generated-type metadata, not manifest resource IDs or physical naming seeds.
- `dependsOn()` lowers to planner-compatible relationship facets and resource links.
- Provider `.with(...)` annotations stay inert manifest data; lowering does not resolve providers.
- Runtime workload factories stay inert and are never executed by the lowering proof.
- The same-kind insertion identity-ledger gap fails closed and is left to HOBO-538.
- Manifest hashing uses a package-local deterministic SHA-256 helper so the proof stays isolated
  from Node ambient type packages while preserving the `sha256:` digest contract.

## Boundary

This package consumes captured closure-builder facts from HOBO-533 and produces a canonical lowering
record for SDK conformance. It does not implement provider resolution, runtime execution, collection
coverage, codegen, scaffolding, app-host imports, or same-kind generated-ID persistence.

## Verification

```powershell
corepack pnpm --prefix src\draft\technical-proofs\closure-builder-manifest-lowering-contract test
```

The package typecheck covers source files only; runtime `node:test` files remain validated by the
same test command through `tsx` instead of requiring repo-global Node type definitions.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the lowering boundary.
- `architecture/pacts/` - PACT contract for the SDK conformance consumer boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
