---
type: Reference
title: "Closure Builder Author Flow Contract"
description: "HOBO-537 proof that the v1 closure-builder corpus is the end-to-end SDK authoring path."
tags: [hobo, proof]
---

# Closure Builder Author Flow Contract

HOBO-537 proof for the v1 closure-builder authoring path.

## What This Proves

- The sample Bindle declares cache, API, and queue resources through `bindle("snapshop", b => ...)`.
- The API handle depends on both cache and queue, and those `dependsOn()` calls lower to
  `hobo.manifest/v1` relationship records and resource link facets.
- Returned aliases type-check as generated authoring aliases while deployment identity remains the
  generated resource ID.
- Generated ID stability and app-host separation are documented in the public example, SDK contract,
  and proof notes.
- The conformance report names the closure-builder author-flow corpus as the v1 SDK authoring path.

## Boundary

This package stitches together the completed closure-builder resource-handle and manifest-lowering
proofs into one author-facing corpus. It does not implement a provider deploy path, app-host runtime,
legacy migration guide, same-kind identity ledger, or production codegen.

## Verification

```powershell
corepack pnpm --prefix src\draft\technical-proofs\closure-builder-author-flow-contract test
```

The package typecheck covers source files plus `test/type-fixtures/`; runtime `node:test` files are
validated by the same test command through `tsx` without requiring repo-global Node type definitions.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the author-flow corpus boundary.
- `architecture/pacts/` - PACT contract for the SDK conformance consumer boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
