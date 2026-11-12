---
type: CI Performance Finding
title: "Finding 140: main shard tsc codegen memory contention"
description: "Scheduled main run 43207388098 on fb51fd87d: shard 0 cli packaged roots and shard 6 auth tsc exceeded Vitest timeouts while the box was memory-thin."
tags: [hobo, ci, performance, main-gate, vitest, typescript, memory, shards]
---

# Finding 140: main shard tsc codegen memory contention

## Evidence

Main Fabric run [43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098) on `fb51fd87d` (scheduled **2026-11-12**):

| Shard | Job | Test | Limit |
| --- | --- | --- | --- |
| 0 | [131150224008](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098/job/131150224008) | `@hobo/cli` `typescript-project-codegen-packaged-execution.test.ts` — *executes graph application roots…* | 60s |
| 6 | [131150224016](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098/job/131150224016) | `@hobo/auth-authoring-surface-contract` `auth-authoring-surface.test.ts` — *type declarations narrow providers…* | 10s (repo default) |

Box was short on memory while seven workspace shards plus trunk work shared the fleet.

## Cause

1. **Packaged execution roots** — each `it.each` case runs full TypeScript project codegen plus in-process `tsc` emit on a cold temp tree; under memory/CPU pile-up the **60s** describe budget was insufficient (clean local **~1.4s/case**, **~5s** for three cases).
2. **Auth authoring surface** — the type-narrowing case spawned a **fresh `tsc --noEmit`** per test while the proof package inherited the repo-wide **10s** Vitest default; a cold compiler process under contention exceeded **10s** even though compile work is tiny once warm.

## Fix

- **`@hobo/cli`:** `beforeAll` warmup (`fixture` + codegen + `compile`) to prime the shared declaration cache and compiler path; raise packaged-execution timeout to **`slow(120_000)`** with measured clean-run note.
- **`@hobo/auth-authoring-surface-contract`:** hoist **`tsc --noEmit`** to **`beforeAll`** with **`slow(60_000)`** on the hook/describe plus **`spawnSync` timeout** (root draft shards ignore package vitest config); proof **`ADR.md`** records the decision.

## Measure

On a memory-thin main shard: packaged roots and auth typecheck complete inside Vitest limits without skipping or weakening assertions; no new job timeout above **20 minutes**.

## Verified

- `pnpm exec vitest run --config packages/cli/vitest.config.ts packages/cli/test/typescript-project-codegen-packaged-execution.test.ts`
- `pnpm --prefix src/draft/technical-proofs/hobo-auth-authoring-surface test`
