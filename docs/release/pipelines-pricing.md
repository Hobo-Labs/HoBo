---
type: Reference
title: "@hobo/pricing release pipeline"
description: "Hermetic release workflow for @hobo/pricing: npm pack dry runs on pull requests, a tag-only provenance publish, and the ts-autocode pin it fetches first."
tags: [hobo, release, ci, npm, pricing]
---

# @hobo/pricing release pipeline

Hermetic **`runs-on: hobo`** workflow **`.github/workflows/release-pricing.yml`** publishes **`@hobo-labs/pricing`** from **`@hobo/pricing`** using **`release/npm-scope-map.json`** and **`scripts/ci/npm-publish-scope.mts`**.

Pull requests run **`npm pack --dry-run` only** (no npm credentials). Tag pushes matching **`pricing-v*.*.*`** run the same build and pack gates, then a **tag-only** publish job that requires **`secrets.NPM_TOKEN`**, runs **`npm publish --access public --provenance`**, and **fails closed** when the token is absent (no skip).

Each job runs **`pnpm run pins:fetch ts-autocode`** (SHA-pinned gitlink in **`tools/pins/siblings.json`**) before **`pnpm install`**, so root **`prepare`** can link the ts-autocode workspace cone the same way **`release-hobo.yml`** and **`release-code.yml`** do.

Dedicated integration CI lives in **`.github/workflows/pricing-ci.yml`** (path-filtered to `packages/pricing/**` and pricing integration surfaces).
