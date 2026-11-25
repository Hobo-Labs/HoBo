# HOBO-67 resource collection engine contract

Independent draft POC for [HOBO-606](https://linear.app/quickdeploy-ai/issue/HOBO-606) / S1-16 resource-collection engine.

Promotion target: `packages/collector` (`@hobo/collector`) once S1-13 (`@hobo/bindles` catalog) and S1-14 (`hobo.manifest/v1` inside bindles) land on `main`.

## What this proves

- `collectBindleResources(...)` executes a Bindle definition in collection mode and emits `hobo.manifest/v1`.
- `parseCollectionInput(raw)` is the single parse-don't-validate boundary.
- Resource declarations come from the `@hobo/bindles` catalog factories (draft catalog proof).
- Bind edges become manifest `links`; used verbs infer manifest `allow` / `usage`.
- Exactly two ordered facts: `bindle.ResourcesCollected` (seq 1) then `bindle.ManifestProduced` (seq 2), `source: "hobo.collector"`.
- Injectable `CoverageEvaluator` seam (default pass-through; coverage gate injectable in tests).
- Clock/network side effects sandboxed as `disposition: "ignored"` for deterministic hashing.
- `examples/hello-bindle` golden manifest fixture (byte-stable).

## Tests

```bash
pnpm --prefix src/draft/technical-proofs/resource-collection-engine-contract test
```

## Architecture evidence

- `architecture/collector.proto` + `architecture/collector.cue` — collection records
- `architecture/pacts/hobo-collector-hobo-bindles.pact.json` — collector ↔ bindles catalog pact

## Testing

Run `pnpm --filter @hobo-draft/resource-collection-engine-contract test`
(Vitest). The golden-manifest case pins a local fixture under
`test/fixtures/hello-bindle.manifest.json` (the shared example manifest was
repurposed by the S1-15 bind-wiring promotion for other proofs).
