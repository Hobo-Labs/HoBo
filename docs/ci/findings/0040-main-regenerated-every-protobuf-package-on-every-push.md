---
type: CI Performance Finding
title: "Finding 40: main regenerated every protobuf package on every push"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 40: main regenerated every protobuf package on every push

The main-only Generated-output drift step cost **17–20 s** even for a push with no generator-input change. It ran the exact `pnpm run codegen:check` over all 24 opted-in packages and ran the frozen S0-04 proof directly, outside Turbo's cache.

`pnpm run codegen:check:affected` now hashes each package's `data-models/**` and checked-in `src/_generated/**`, together with the shared inputs the checker reads: `buf.gen.yaml`, `packages/schema-tools/src/**`, the resolved buf and protoc-gen-es versions in `pnpm-lock.yaml`, and the CUE pins in `mise.toml` and `mise.lock`. Only a package without a matching CLEAN stamp runs `checkCodegen`; drift and CUE failures write no stamp and retain the exact check's nonzero exit. Stamps are atomic and content-addressed, and missing or malformed stamps are misses. `HOBO_CODEGEN_CACHE_DIR` overrides the cache location; otherwise it lives beside `TURBO_CACHE_DIR` when set, or under `node_modules/.cache/hobo-codegen-check`. The full `pnpm run codegen:check` remains unchanged as the exact uncached gate.

The workflow also runs the frozen proof through `turbo run test --filter=@hobo-draft/s0-04-protobuf-cue-codegen`, so Turbo hashes and caches its own inputs without editing the proof. Local wall-clock measurements were **12.72 s cold**, **0.63 s warm** (24 hits), and **1.15 s after one core data-model edit** (23 hits, one miss, 468 ms package check). The edit was reverted after measurement.
