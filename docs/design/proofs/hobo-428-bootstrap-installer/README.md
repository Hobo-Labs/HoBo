---
type: Reference
title: "HOBO-428 Bootstrap Installer M0 Proof"
description: "Source issue: HOBO-428."
tags: [hobo, design]
---

# HOBO-428 Bootstrap Installer M0 Proof

This proof package demonstrates that HOBO-428 records accepted M0 scope before follow-up Bootstrap
Installer design/build work can fan out.

## Evidence

- Design record:
  [`docs/design/bootstrap-installer.md`](../../bootstrap-installer.md)
- Executable contract:
  [`src/draft/exp-proofs/dx/bootstrap-installer-scope-contract`](../../../../src/draft/exp-proofs/dx/bootstrap-installer-scope-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
npm.cmd --prefix src\draft\exp-proofs\bootstrap-installer-scope-contract test
```

The check proves the HOBO-428 acceptance bullets and scope boundaries:

- explicit user/business goal and primary personas;
- recorded scope in/out, non-goals, and service/UX/security/support boundaries;
- mapped dependencies to DX, walkthrough, dogfood, bootstrap ADR, air-gap ADR, and identity ADR sources;
- owning initiative dependencies and handoff boundaries;
- evidence required for M1 design and contract proof;
- follow-up gate preventing M1-M4 issue creation before M0 acceptance;
- rejected scope creep into production installer scripts, live provisioning, account/auth
  implementation, first deploy execution, secret collection, or uninstall cleanup.
