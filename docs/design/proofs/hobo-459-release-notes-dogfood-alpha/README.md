---
type: Reference
title: "HOBO-459 Release Notes Dogfood Alpha Proof"
description: "Source issue: HOBO-459."
tags: [hobo, design]
---

# HOBO-459 Release Notes Dogfood Alpha Proof

HOBO-459 is proven by the focused M1 contract at
[`src/draft/exp-proofs/cx/v1-release-notes-dogfood-alpha-evidence`](../../../../src/draft/exp-proofs/cx/v1-release-notes-dogfood-alpha-evidence/README.md)
and the durable release-notes record at
[release-notes-upgrade-guide.md](../../release-notes-upgrade-guide.md).

## Acceptance Evidence

- Required dogfood/alpha evidence is listed and mapped to owning launch
  projects, release-note sections, and v1 cutline blocker categories.
- Blockers and accepted risks are explicit gate records.
- Cross-project dependencies are reflected through release-cutline categories.
- Follow-up execution issues are created only when evidence is missing.
- Parent HoBo v1 Release Readiness status update is required when the gate
  changes launch risk.

## Negative Coverage

- Missing evidence without a follow-up issue is rejected.
- Follow-up issues for already accepted evidence are rejected.
- Launch-risk changes without a parent release-readiness status update are
  rejected.

## Verification

```powershell
npm.cmd --prefix src\draft\v1-release-notes-dogfood-alpha-evidence test
```
