---
layout: ../../layouts/Docs.astro
title: Dual fixtures
description: "One metadata description, two paths: pure isolation vs effectful path — plus identity dual-path fixtures for continuous migration."
---

# Dual fixtures

**Dual fixtures** keep pure and effectful (or dual-path identity) tests aligned from the **same metadata** so they cannot silently diverge.

## Effect duals

| Path | When | Infrastructure |
|---|---|---|
| **Pure** | `isPure` / no domain I/O | Zero infra; effect isolation harness |
| **Effectful** | Domains present | Automatic mocks from EffectSpec + optional live |

Same contract id, same examples, different routing. If pure path asserts X and effectful asserts ¬X, the fixture definition is wrong — fix metadata, not only one side.

## Identity duals

Continuous identity migration uses dual-path principal fixtures:

- Old and new principal shapes evaluate together
- Matching/policy decides continuity
- Offline fixtures extend without live IdP

## Migration duals

Schema/data dual windows: produce fixtures that assert both old and new folds during the dual period, then cutover.

## Session Replay duals

Local Session Replay (default on every **App Kit**) stores heavy blobs via **dual-fixture** adapters (memory/fixture engines) so privacy + tracker/player contracts stay offline-green without multi-cloud object storage. Production binds object-storage ports; dual fixtures remain the proof path. See [Session Replay](/HoBo/reference/session-replay/) · [App Kits](/HoBo/primitives/app-kits/).

## Rules

1. One source of truth for input shapes (contract examples / fixture tables).
2. Name duals explicitly in test titles (`pure:` / `effect:` / `dual-id:`).
3. Never hand-maintain two mock graphs that claim to be the same boundary.

## Related

[Effect-aware isolation](/HoBo/testing/effects/) · [Migration fixtures](/HoBo/testing/migration/) · [Identity](/HoBo/security/identity/)
