---
type: Reference
title: "HOBO-462 Dogfood Yard Private Beta Evidence Proof"
description: "Source issue: HOBO-462."
tags: [hobo, design]
---

# HOBO-462 Dogfood Yard Private Beta Evidence Proof

HOBO-462 is proven by the focused M2 contract at
[`src/draft/exp-proofs/dx/dogfood-yard-private-beta-evidence-contract`](../../../../src/draft/exp-proofs/dx/dogfood-yard-private-beta-evidence-contract/README.md)
and the durable Dogfood Yard scope record at [dogfood-yard.md](../../dogfood-yard.md).

## Acceptance Evidence

- Required M2 evidence is listed and mapped to owning projects and source records.
- Private beta scenarios cover hosted preview, self-host seed handover, Yard upgrade/rollback, and
  incident debug/restore using sanitized fixtures only.
- Logs, traces, status views, support/debug bundles, and rollback signals have owners, redaction
  rules, and private beta use.
- Blockers and accepted risks are recorded with launch-risk disposition.
- Release notes, support, bootstrap, reliability, and broker dependencies are reflected in the
  release cutline handoff.
- Only missing M3/M4 evidence has follow-up issue links: HOBO-469 and HOBO-476.

## Negative Coverage

- Validation rejects pending evidence, speculative follow-ups, and changed launch risk without
  parent status sync.
- Validation rejects live customer data, live provider calls, production readiness promotion in any
  claim boundary, and scope creep into hosted runtime, admin UI, support automation, provider
  adapters, or bootstrap implementation.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\dogfood-yard-private-beta-evidence-contract test
pnpm.cmd agent:check -- --staged
```
