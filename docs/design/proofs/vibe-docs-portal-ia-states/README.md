---
type: Design Proof Evidence
title: "HOBO-551 Vibe Docs Portal IA States Proof"
description: "M1 proof record for Docs Portal information architecture, audience paths, search metadata, and stale-content states."
tags: [hobo, proof, docs-portal, ia, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-551 Vibe Docs Portal IA States Proof

This proof records branch evidence for Docs Portal information architecture,
audience paths, search metadata, and stale-content states for launch-critical
docs.

## Evidence

- Source record: [`docs-portal.md`](../../docs-portal.md).
- DX source: [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07).
- Quickstart source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Executable proof: [`vibe-docs-portal-ia-states`](../../../../src/draft/exp-proofs/ux/vibe-docs-portal-ia-states/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| IA covers getting started, API reference, architecture, operations, troubleshooting, release notes, known limitations, security, and support. | `contentInventory` is parsed in the required content-area order. |
| Fixtures name title, slug, audience, content area, source record, owner, freshness signal, proof mode, limitation state, and support/release owner. | `contentInventory` and `searchMetadata` carry those fields for every launch-critical page class and reject unsupported audience, freshness, proof-mode, and limitation labels. |
| Package and proof path match the issue. | `parseVibeDocsPortalIaStates` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof modes are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state and label. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into a docs
portal UI, CMS, publishing pipeline, search service, analytics pipeline, final
copy pass, support queue, security intake, production UI, or launch claim
without owner evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-docs-portal-ia-states test
```
