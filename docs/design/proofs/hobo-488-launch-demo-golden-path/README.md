---
type: Reference
title: "HOBO-488 Launch Demo Golden Path Proof"
description: "Source issue: HOBO-488."
tags: [hobo, design]
---

# HOBO-488 Launch Demo Golden Path Proof

HOBO-488 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/launch-demo-golden-path-contract`](../../../../src/draft/exp-proofs/dx/launch-demo-golden-path-contract/README.md)
and the durable design record at
[`launch-demo-golden-path.md`](../../launch-demo-golden-path.md).

## Acceptance Evidence

- `snapshop` is named as the sample app and links back to Plan 19.
- The path names primary persona, setup prerequisites, command path, screens, expected outputs,
  failure recovery, and evidence artifacts.
- Proof modes distinguish live product behavior from reference fixtures and simulated references.
- Required assets cover screenshots, recording manifest, command transcript, fixture data, and docs.
- The issue stays within checklist/proof scope and does not build a demo app or marketing surface.

## Negative Coverage

- Validation rejects marketing polish, launch-site, or demo-implementation scope creep.
- Validation rejects missing proof modes for command steps, outputs, or evidence artifacts.
- Validation rejects missing required proof assets.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\launch-demo-golden-path-contract test
```
