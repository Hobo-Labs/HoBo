---
type: Reference
title: "HOBO-504 Release Artifact Provenance Retention Proof"
description: "Source issue: HOBO-504."
tags: [hobo, design]
---

# HOBO-504 Release Artifact Provenance Retention Proof

Executable artifact:
[`release-artifact-provenance-retention-contract`](../../../../src/draft/technical-proofs/release-artifact-provenance-retention-contract/README.md).

The proof validates the M0 handoff record for artifact classes, provenance source, retention period,
invalidation/yank handling, offline bundle expectations, support/debug access, owner lanes, and
known gap disposition.

Acceptance coverage:

| Acceptance | Executable evidence |
|---|---|
| Artifact classes and handoff fields are defined. | `HOBO-504 record defines required artifact classes and handoff fields` |
| Release engineering, artifact store, package cache, registry, compliance, and support are linked. | `handoff links release engineering, artifact store, package cache, registry, compliance, and support` |
| Known gaps are marked beta limitation, GA blocker, or post-GA follow-up. | `known gaps are classified as beta limitation, GA blocker, or post-GA follow-up` |
| No artifact store implementation lands in this issue. | `validation rejects artifact-store implementation scope creep and unclassified gaps` |

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\release-artifact-provenance-retention-contract test
```
