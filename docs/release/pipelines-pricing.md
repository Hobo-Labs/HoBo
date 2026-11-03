# @hobo/pricing release pipeline

Hermetic **`runs-on: hobo`** workflow **`.github/workflows/release-pricing.yml`** publishes **`@hobo-labs/pricing`** from **`@hobo/pricing`** using **`release/npm-scope-map.json`** and **`scripts/ci/npm-publish-scope.mts`**. Pull requests run **`npm pack --dry-run` only** (no npm credentials). Tag pushes use the `pricing-v*.*.*` pattern for release verification.

Dedicated integration CI lives in **`.github/workflows/pricing-ci.yml`** (path-filtered to `packages/pricing/**` and pricing integration surfaces).
