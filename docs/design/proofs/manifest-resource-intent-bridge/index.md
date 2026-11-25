# HOBO-696 Manifest → ResourceIntent Bridge Proof

Executable proof for the manifest→ResourceIntent bridge on the `hobo plan` spine.

## Contract Surface

- `hobo.manifest/v1` resource nodes lower to provider-neutral `ResourceIntent` records.
- Capability class derives from manifest `port`/`type` and usage requirements.
- `bind`/`links` become colocation constraints; provider `.with(...)` blocks stay out of intent.

## Design Anchors

- [finops-budget-routing-control-plane.md](../../finops-budget-routing-control-plane.md#ifc-and-hobo-plan-spine)
- [control-plane.md](../../control-plane.md#plan-04)

## Executable Checks

```bash
pnpm --prefix src/draft/technical-proofs/manifest-resource-intent-bridge-contract test
```
