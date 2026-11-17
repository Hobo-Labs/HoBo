# Product CLI help and failure honesty

Feature id: `cli-product`

## Seed

A developer or agent runs the real product CLI (`hobo`) and
gets discoverable help, honest JSON envelopes, and non-zero exits on
failure — without live cloud credentials.

## Personas

- `cli-product-product-app-developer.feature` ← `.optimizexp/personas/product-app-developer.md`

## Running

```bash
node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js \
  --config .optimizexp/cucumber.yaml \
  .optimizexp/features/cli-product/*.feature \
  --import ".optimizexp/features/cli-product/steps/**/*.ts"
```

The `hobo` bin needs workspace dependencies built once:
`pnpm --filter @hobo/cli... run build`.

Known-defect characterizations: see [KNOWN-DEFECTS.md](KNOWN-DEFECTS.md).
