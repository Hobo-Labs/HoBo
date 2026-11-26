---
type: Reference
title: "HOBO-486 Workspace Activation Telemetry Proof"
description: "Source issue: HOBO-486."
tags: [hobo, design]
---

# HOBO-486 Workspace Activation Telemetry Proof

HOBO-486 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/workspace-activation-telemetry-contract`](../../../../src/draft/exp-proofs/cx/workspace-activation-telemetry-contract/README.md)
and the durable scope record at
[`workspace-activation-telemetry-contract.md`](../../workspace-activation-telemetry-contract.md).

## Acceptance Evidence

- Activation funnel events cover account creation, workspace creation, project creation, first plan,
  first deploy attempt, first failure recovery, and first successful handoff.
- Every event maps to a product question, support or recovery use, owner project, and proof mode.
- Privacy rules record purpose limits, retention, customer opt-out/export behavior, and PII or
  secret exclusions.
- First-run telemetry is linked to onboarding, plan/diff, deployment dashboard, support, beta
  feedback, release readiness, and pre-launch value evidence without implementing those surfaces.

## Negative Coverage

- Launch activation claims fail closed when required events or owner mappings are missing.
- Scope validation rejects live analytics vendor selection and broad behavioral tracking.
- Captured fields reject raw email, secrets, credentials, tokens, payment data, and provider
  credentials.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\workspace-activation-telemetry-contract test
```
