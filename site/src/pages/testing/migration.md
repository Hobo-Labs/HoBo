---
layout: ../../layouts/Docs.astro
title: Migration fixtures
description: "Legacy schema → current, dual windows, fail-closed integrity, can-trail/can-migrate gates, and Trail golden oracles."
---

# Migration fixtures

Migrations are product features — test them as such.

## Classes

| Class | Prove |
|---|---|
| **Journal schema** | v1 → v2 user_version; integrity checks; fail closed |
| **Event upcast** | Old body bytes → current fold state |
| **Identity continuous** | Dual principal fixtures offline |
| **Trail recipes** | `can-trail`, plan evidence, golden oracles |
| **Infra re-place** | Same Gatekeeper path as deploy |

## Fail closed

| Failure | Expected |
|---|---|
| Noncontiguous seq after migrate | `STREAM_INTEGRITY` / migrate fail |
| Opening newer DB with older code | `UNSUPPORTED_SCHEMA_VERSION` |
| Snapshot ahead of head | `SNAPSHOT_AHEAD` |
| Trail gate fail | No partial cutover mute |

## Dual window tests

While dual is open, both old and new projections must answer consistently for in-window subjects. Cutover tests assert the gate and the terminal single-path state.

## Trail golden

Trails package golden oracles pin plan/run verdicts for recipe shapes — treat like contract tests for migration recipes.

## Related

[Schema](/HoBo/reference/schema/) · [Trails](/HoBo/primitives/trails/) · [Continuous migration](/HoBo/cicd/migration/) · [Dual fixtures](/HoBo/testing/dual-fixtures/)
