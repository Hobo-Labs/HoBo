---
type: Reference
title: "HOBO-430 Upgrade And Migration Engine M0 Proof"
description: "Source issue: HOBO-430."
tags: [hobo, design]
---

# HOBO-430 Upgrade And Migration Engine M0 Proof

This proof package demonstrates that HOBO-430 records accepted M0 scope before follow-up Upgrade &
Migration Engine design/build work can fan out.

## Evidence

- Design record:
  [`docs/design/upgrade-migration-engine.md`](../../upgrade-migration-engine.md)
- Executable contract:
  [`src/draft/exp-proofs/cx/upgrade-migration-scope-contract`](../../../../src/draft/exp-proofs/cx/upgrade-migration-scope-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
npm.cmd --prefix src\draft\exp-proofs\upgrade-migration-scope-contract test
```

The check proves the HOBO-430 acceptance bullets and scope boundaries:

- explicit user/business goal and primary personas;
- recorded scope in/out, non-goals, and service/UX/security/support boundaries;
- mapped dependencies to release notes, compatibility contracts, data migrations, WIT host pins,
  role walkthroughs, and upgrade-related ADRs;
- owning initiative dependencies and handoff boundaries;
- evidence required for M1 design and contract proof;
- follow-up gate preventing M1-M4 issue creation before M0 acceptance;
- rejected scope creep into production upgrade runners, live migration execution, rollback
  execution, backup restore, provider state mutation, compatibility UI, release publication, or
  support automation.
