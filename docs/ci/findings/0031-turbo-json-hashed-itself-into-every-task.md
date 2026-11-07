---
type: CI Performance Finding
title: "Finding 31: turbo.json hashed itself into every task"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 31: turbo.json hashed itself into every task

`turbo.json` appeared in `globalDependencies` from the original Turborepo migration, so every task-definition edit also invalidated every build and test hash. That turned #1707's first merge-group run into a cold repo-wide sweep that could not fit the 25-minute PR impact gate. Turbo 2.11 already includes each resolved task definition in that task's own hash; global environment settings have their own global hash. The file is no longer its own global dependency.

A detached clean-worktree experiment ran `pnpm exec turbo run build test --dry=json` over **792 package builds and 792 package tests**, then compared each successive edit with the immediately preceding dry run:

| Edit | Build hashes changed | Test hashes changed |
|---|---:|---:|
| Remove `turbo.json` from `globalDependencies` (one-time migration) | 792 / 792 | 792 / 792 |
| Edit only `//#test:unit:draft:0` inputs | **0 / 792** | **0 / 792** |
| Add `!package.json` to generic `test` inputs | 0 / 792 | **788 / 792** |
| Add `!package.json` to `@hobo/code#test` inputs | 0 / 792 | **1 / 792** |
| Add `globalEnv` | **792 / 792** | **792 / 792** |

The four package tests unchanged by the generic-input edit were `@hobo/code`, `@hobo/conformance`, `@hobo/hobo`, and `@hobo/runtime`: their package-specific overrides replace generic inputs. The package override changed only `@hobo/code#test`. Thus unrelated root task edits stay local, while shared task and environment changes retain their required scope.

`scripts/ci/affected-lanes.mts` now compares Turbo content with the diff base: root `//#` task edits stay affected-only, while `globalDependencies`, shared task, and environment edits select the repo-wide main gate. `release-oci-affected.mts` continues hashing only build-relevant turbo settings, including the `globalDependencies` list and build task definitions; it deliberately does not rebuild images for test-only task edits. Its tests pin both behaviors.
