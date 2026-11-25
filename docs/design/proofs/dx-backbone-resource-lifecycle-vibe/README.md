---
type: Reference
title: "DX Backbone Resource Lifecycle Vibe Proof"
description: "Source issue: HOBO-566."
tags: [hobo, design]
---

# HOBO-566 DX Backbone Resource Lifecycle Vibe Proof

HOBO-566 is proven by the focused experience proof at
[`src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe`](../../../../src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe/README.md).

## Acceptance Evidence

- Child slices HOBO-567 through HOBO-577 cover scenario matrix, SDK shape,
  control-plane API shape, CLI/MCP parity, typed refusal/result envelopes,
  deterministic fixture corpus, deploy/manage/migration transcripts,
  SDK-to-CLI golden path, and resource-lifecycle quickstart examples.
- Every child slice names an isolated `src/draft/exp-proofs/<slug>` package and
  matching `docs/design/proofs/<slug>/README.md` proof note.
- M2 transcript and quickstart slices wait for M1 shape, envelope, and fixture
  foundations before claiming prototype readiness.
- Docs, tutorials, troubleshooting, launch, workspace, plan/diff, dashboard,
  marketplace, support, and accessibility consumers must consume HOBO-577
  quickstart evidence instead of inventing behavior.
- Proof-mode labels are closed over `live`, `simulated`, `reference fixture`,
  and `scope-out`.

## Adversarial Evidence

- Production CLI/API/SDK implementation requests are refused.
- Live provider calls, real credentials, real customer data, and public launch
  claims without evidence are refused.
- Dashboard/UI-first mockups that invent behavior before the DX source material
  is accepted are refused.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\dx-backbone-resource-lifecycle-vibe test
```
