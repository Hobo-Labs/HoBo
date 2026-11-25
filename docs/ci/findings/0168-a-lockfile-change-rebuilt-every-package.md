---
type: CI Performance Finding
title: "Finding 168: a lockfile change rebuilt every package"
description: "turbo.json listed pnpm-lock.yaml in globalDependencies, so any dependency change anywhere changed the hash of every task and a restored main-build cache could not serve a single build. Turbo already hashes each package's resolved external dependencies from the lockfile; with the global entry removed, a one-package dependency bump changes only that package's tasks and its dependents'."
tags: [hobo, ci, performance, turbo, pnpm, lockfile]
---

# Finding 168: a lockfile change rebuilt every package

## Measurements

Merge-group run 45393405752 (pull request 2709, which changes `pnpm-lock.yaml`) restored the `main-build` Turbo cache, and all 170 build tasks still reported "cache miss, executing".

`turbo.json` listed `pnpm-lock.yaml` in `globalDependencies`. A global dependency's content goes into the global hash, which every task hash includes. Turbo 2.11 already reads the lockfile itself: each task carries `hashOfExternalDependencies`, the hash of that package's resolved external dependency closure, and the root package's closure is part of the global hash.

`turbo run build --dry=json` at origin/main (`5a3715815f`), 828 build tasks, Turbo 2.11.10. Each row bumps `@types/node` from `^22.15.29` to `22.19.0` in one package and regenerates the lockfile with `pnpm install --lockfile-only`:

| Change | Task hashes changed, lockfile global | Task hashes changed, no lockfile global |
| --- | --- | --- |
| Leaf `@hobo/capability-matrix` | 828 / 828 | 1 / 828 (`@hobo/capability-matrix#build`) |
| `@hobo/adapter-infisical` (six direct dependents) | 828 / 828 | 8 / 828 (the package and its seven transitive dependents) |

Only the bumped package's `hashOfExternalDependencies` changed in both rows. Removing the global entry alone changes all 828 hashes once.

## Fix

`pnpm-lock.yaml` is no longer a Turbo global dependency. `pnpm-workspace.yaml`, `tsconfig.base.json` and `scripts/visual-token-contract.json` stay. A dependency change now invalidates the packages whose resolved dependencies changed, plus their dependents, and the rest of the `main-build` cache still hits. The `.github/actions/turbo-cache` keys keep their lockfile hash; that only scopes which archive a job restores.

The monorepo playbook's reference `turbo.json` drops the lockfile too.

## Expected effect

A dependency bump in one package rebuilds that package and its dependents instead of the whole workspace. Package selection with `--filter=...[base]` does not change: Turbo already scoped a lockfile edit to the packages whose resolutions changed, with or without the global entry; the global entry only made every selected task miss the cache.

## Remaining limits

- A change to the root importer's resolved dependencies still changes the global hash and every task. pnpm can rewrite them as a side effect: main's lockfile holds one of two peer resolutions that `pnpm install --frozen-lockfile` accepts, and the first `pnpm install` that changes any dependency switches the root's `@alchemy.run/rivet` entry and two package entries to the other. The first measured bump did exactly that and changed all 828 hashes even without the global entry; the table rows start from the settled resolution, where the same bump changes only the lines it needs.
- Pull request 2709 itself also changes `packages/core` (139 of 156 `packages/` builds depend on it) and that root entry, so it would still have rebuilt nearly everything.
- `scripts/ci/affected-lanes.mts` still plans the whole workspace for a lockfile-only diff. That decides which lanes run, not whether their builds hit the cache.
- This change runs the whole workspace once, because it removes a `globalDependencies` entry.
