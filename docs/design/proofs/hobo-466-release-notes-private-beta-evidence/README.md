---
type: Reference
title: "HOBO-466 Release Notes Private Beta Evidence Proof"
description: "Source issue: HOBO-466."
tags: [hobo, design]
---

# HOBO-466 Release Notes Private Beta Evidence Proof

HOBO-466 is proven by the focused M2 contract at
[`src/draft/exp-proofs/cx/v1-release-notes-private-beta-evidence-contract`](../../../../src/draft/exp-proofs/cx/v1-release-notes-private-beta-evidence-contract/README.md)
and the durable release-note outline at [release-notes-upgrade-guide.md](../../release-notes-upgrade-guide.md).

## Acceptance Evidence

- Required private-beta evidence is listed and mapped to owning projects:
  Release Notes & Upgrade Guide, Release Program & Cutline, Upgrade & Migration Engine, Upgrade
  Test Suite, Beta Pilot & Feedback Loop, Support Workflow, and V1 Docs.
- Blockers and accepted risks are recorded with owners, mitigations, and M3 revisit gates.
- Cross-project dependencies are reflected in the release cutline for every evidence owner.
- Follow-up execution issues are rejected unless the referenced evidence is missing.
- HoBo v1 Release Readiness status-update evidence is required whenever this gate changes launch
  risk.

## Negative Coverage

- Speculative follow-ups for already accepted evidence fail validation.
- The M2 private-beta gate cannot complete while required evidence is missing.
- Parent release-readiness launch-risk changes fail without status-update evidence.
- Malformed nested evidence payloads and unsupported evidence statuses fail closed without throwing.

## Verification

```powershell
npm.cmd --prefix src\draft\v1-release-notes-private-beta-evidence-contract test
```
