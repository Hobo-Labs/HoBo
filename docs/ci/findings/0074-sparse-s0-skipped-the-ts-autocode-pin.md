---
type: CI Performance Finding
title: "Finding 74: sparse S0 skipped the ts-autocode pin"
description: "Main full gate Install dependencies failed after #1743 because sparse checkout left the ts-autocode gitlink empty."
tags: [hobo, ci, performance, checkout, sparse, pins]
---

# Finding 74: sparse S0 skipped the ts-autocode pin

## Symptom

Main Fabric [42011481177](https://github.com/Hobo-Labs/HoBo/actions/runs/42011481177) at `6464a491` (#1743) failed
**Install dependencies**: `ensure-ts-autocode-links.mts` reported the ts-autocode sibling packages were not
linked. The background secret scan then timed out after 300 s (cascade). Sparse S0 checkout itself was about
**6 s**.

## Cause

#1743 set `submodules: "false"` so S0 no longer recursively cloned ts-autocode. The cone still lists `external/`,
which is only the gitlink. `deps-key` needs
`external/ts-autocode/packages/{grounding,training,rewrite}/package.json`. Those files are missing, so
`depsKeyForRoot` throws, deps-layer check reports `checkout-key` miss, and `pnpm install` `prepare` dies.

Release jobs already run `pnpm run pins:fetch ts-autocode` after the same sparse checkout. Main full gate did not.

## Fix

Main full gate fetches the pin after `ci-runner-preflight` and before Link deps layer, and skips the fetch when
the three cone manifests are already present. Checkout stays sparse, blobless, and non-recursive. The pin cone
is grounding/training/rewrite only.

## Verification

`scripts/test/s0-checkout-cone.test.ts` asserts `pins:fetch ts-autocode` sits after preflight and before
deps-layer/install, that the cone covers `PINS_FETCH_REQUIRED_FILES` plus
`TS_AUTOCODE_PNPM_PREPARE_REQUIRED`, and that `submodules: recursive` stays absent. Sparse S0 target remains
about 10–12 s; the pin fetch is the designed shallow cone, not a full submodule clone.
