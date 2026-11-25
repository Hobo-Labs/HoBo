---
type: Reference
title: "HOBO-511 Supported Platform Matrix Proof"
description: "Source issue: HOBO-511."
tags: [hobo, design]
---

# HOBO-511 Supported Platform Matrix Proof

HOBO-511 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/v1-supported-platform-matrix-contract`](../../../../src/draft/exp-proofs/cx/v1-supported-platform-matrix-contract/README.md)
and the durable support record at [compatibility-matrix.md](../../compatibility-matrix.md).

## Acceptance Evidence

- Desktop browser support names Chrome, Edge, Firefox, and Safari with beta and GA support levels.
- Mobile/responsive support has a limited v1 posture, a 390px viewport floor, supported lightweight
  uses, and unsupported authoring uses.
- CLI and local bootstrap support names macOS, Linux, and Windows platform assumptions.
- Every support claim maps to one or more allowed evidence sources.
- Unsupported browser/device/platform reports route to support debug, release notes, or known limitations.

## Negative Coverage

- Scope validation rejects broad device-lab, native mobile app, and automated browser-grid expansion.
- Matrix validation rejects package/runtime-only compatibility records that omit user-facing browser
  and device support.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\v1-supported-platform-matrix-contract test
```
