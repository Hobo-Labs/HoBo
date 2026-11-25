---
type: Runbook
title: "HoBo.CD runbook: Authorization"
description: "Delivery authorization decisions. Assembled from the Runbook section of packages/cd/src/authz/README.md."
tags: [hobo, cd, runbook, authz]
---

# HoBo.CD runbook: Authorization

Delivery authorization decisions. This page is assembled from the **Runbook** section of `packages/cd/src/authz/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **Agent actions keep landing as proposals.** Expected (ADR-0094). To let an
  agent act, add it to `agentGrants` (`{ "<agent id>": ["drift.remediate"] }`)
  in composition, scoped to the fewest actions; never grant `*` in prod.
- **`separation-of-duties` on enrollment.** The same operator approved the key
  and tried to accept the reconciler (or the reverse). Ask a second operator;
  do not disable `separateEnrollmentApprovers` outside single-operator dev.
- **`cd-authz-unrecorded` spike** (`hobo.cd.authz.refusals{reason=cd-authz-unrecorded}`).
  The event store is unavailable or contended; every mutation is refused until
  it recovers. Check store health (SQLite busy, Postgres reachability), then
  retry the refused commands; they are idempotent.
- **Audit a decision.** Take the decision id from the refusal's `subject` (or
  the caller's record), find the resource from the caller, and read
  `decisions({ kind, id })`: effect, reason, matched `policyIds`, pack id and
  version, and `inputHash` for replay.
