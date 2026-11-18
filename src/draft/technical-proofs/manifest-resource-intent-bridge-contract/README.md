---
type: Reference
title: "Manifest → ResourceIntent Bridge Contract"
description: "HOBO-696 proof for lowering hobo.manifest/v1 resource nodes to provider-neutral ResourceIntent on the hobo plan spine."
tags: [hobo, proof, finops, ifc]
---

# Manifest → ResourceIntent Bridge Contract

HOBO-696 / REM-027 proof for the manifest→ResourceIntent bridge documented in
[finops-budget-routing-control-plane.md](urn:hobo:requirement:finops-budget-routing-control-plane#ifc-and-hobo-plan-spine)
and [control-plane.md](urn:hobo:requirement:control-plane#plan-04).

## What This Proves

- Each `hobo.manifest/v1` resource node lowers to one provider-neutral `ResourceIntent`.
- Capability class derives from manifest `port`/`type` and `require`/`prefer` annotations.
- Budget scope and routing objective come from deploy context, not provider SKUs.
- Provider-specific `.with(...)` blocks, regions, and account ids are excluded from intent.
- `bind`/`links` dependency names become colocation constraint references.

## Boundary

Read-only plan-time lowering only. Does not run Matching, FinOps routing, or
provider resolution. Those remain owned by the control-plane and FinOps epic
proofs.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/manifest-resource-intent-bridge-contract test
```

## Executable evidence
This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for the bridge boundary.
- `architecture/pacts/` — PACT contract for the Planner→FinOps consumer boundary.
