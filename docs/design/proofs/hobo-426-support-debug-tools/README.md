---
type: Reference
title: "HOBO-426 Support & Debug Tools M0 Scope Proof"
description: "Source issue: HOBO-426."
tags: [hobo, design]
---

# HOBO-426 Support & Debug Tools M0 Scope Proof

HOBO-426 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/support-debug-tools-scope-contract`](../../../../src/draft/exp-proofs/cx/support-debug-tools-scope-contract/README.md)
and the durable scope record at [support-debug-tools.md](../../support-debug-tools.md).

## Acceptance Evidence

- Goal and personas are explicit for support operators, on-call responders, workspace admins,
  platform engineers, and security/compliance reviewers.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 07, Plan 49, workspace activation telemetry, Admin Console, Audit
  Explorer, Support SLA Channels, Launch Support Escalation, Operators/SRE, Data Plane, ADR-0074,
  ADR-0050, and ADR-0058.
- Owning initiative dependencies map Support & Debug Tools, Admin Console, Audit Explorer, Support
  Workflow, Operators/SRE, Reliability/Observability/Cost, Security Verification, CLI/MCP, and Data
  Plane consumption without taking their implementation scope.
- Diagnostic bundle classes and recovery routes are named with owners, event families, redaction,
  safe fields, and no mutation authority.
- M1 evidence is listed as diagnostic bundle contract, redaction/no-secret fixture, recovery route
  matrix, read-only tool intent, incident handoff context, replay correlation fixture, and scope
  boundary gate.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects UI implementation, support ticketing, live log/trace collection,
  event-store/projector/search runtime, runbook remediation, RBAC enforcement, provider credential,
  secret material, raw customer-data, or follow-up implementation creep.
- Request routing keeps Admin Console, Support Workflow, Operators/SRE, Data Plane, Security
  Verification, and CLI/MCP decisions with their owning initiatives.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

The proof package is registered in `pnpm-lock.yaml` so frozen installs include
the workspace importer before PR gates run.
It also declares `@types/node` locally because its TypeScript contract includes
Node test APIs and CI runs the package typecheck in workspace isolation.

```powershell
pnpm --dir src\draft\support-debug-tools-scope-contract test
pnpm --dir src\draft\support-debug-tools-scope-contract typecheck
```
