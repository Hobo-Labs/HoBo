---
type: Reference
title: "HOBO-458 Launch Site Demo Alpha Evidence Proof"
description: "Source issue: HOBO-458."
tags: [hobo, design]
---

# HOBO-458 Launch Site Demo Alpha Evidence Proof

HOBO-458 is proven by the focused M1 contract at
[`src/draft/exp-proofs/cx/launch-site-demo-alpha-evidence-contract`](../../../../src/draft/exp-proofs/cx/launch-site-demo-alpha-evidence-contract/README.md)
and the durable design record in
[`launch-messaging-claims.md`](../../launch-messaging-claims.md#m1-dogfoodalpha-evidence-gate).

## Acceptance Evidence

- Required M1 evidence is listed and mapped to owner projects.
- Blockers and accepted risks record owner, mitigation, and launch-risk effect.
- Cross-project dependencies map to v1 cutline domains for documentation, productization, and
  operations readiness.
- Follow-up execution issues are allowed only for evidence marked missing.
- Parent initiative status update evidence is required when the gate changes launch risk.

## Negative Coverage

- Validation rejects follow-up execution work for accepted evidence.
- Validation rejects increased launch risk without parent-initiative update evidence.
- Validation rejects public launch-site implementation scope creep.
- Validation rejects publishing public claims from reference fixtures or alpha-only evidence.

## Verification

```powershell
pnpm --dir src\draft\exp-proofs\launch-site-demo-alpha-evidence-contract test
```
