---
type: Reference
title: "HOBO-452 Compliance Evidence Pack Evidence"
description: "Source issue: HOBO-452."
tags: [hobo, design]
---

# HOBO-452 Compliance Evidence Pack Evidence

Issue: HOBO-452.

## Branch Proof

Focused gate:

```powershell
pnpm --prefix src\draft\compliance-evidence-pack-scope test
```

Workspace metadata:

- `pnpm-lock.yaml` includes `src/draft/exp-proofs/cx/compliance-evidence-pack-scope` as a workspace importer so
  install and relevant-check lanes see the proof package consistently.

## Acceptance Evidence

- User/business goal and primary personas are recorded in
  `docs/design/compliance-evidence-pack.md` and `COMPLIANCE_EVIDENCE_PACK_SCOPE`.
- Scope in/out, non-goals, and service/UX/security/support/legal/release boundaries are executable
  in the validator.
- The validator fails closed if the accepted M0 record loses its goal, required personas,
  scope-out/non-goal text, or required service/UX/security/support/legal/release boundaries.
- Assurance packet sections are mapped to Security Verification, Tenant Data Lifecycle, SBOM and
  notices, Legal/Privacy/Terms, Backup & Restore, Support Workflow, and V1 Release Program &
  Cutline.
- M1 evidence requirements are enumerated and require owner, proof mode, and claim.
- M1-M4 follow-up creation remains blocked until this M0 record is accepted.

## Scope Guard Evidence

The focused test rejects scope creep into legal approval, live compliance systems, support access to
production customer data, proofless customer-facing compliance claims, and missing required packet
sections.
