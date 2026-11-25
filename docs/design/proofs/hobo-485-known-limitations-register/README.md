---
type: Reference
title: "HOBO-485 Known Limitations Register Proof"
description: "Source issue: HOBO-485."
tags: [hobo, design]
---

# HOBO-485 Known Limitations Register Proof

This proof records the customer-facing known limitations and scope-out register
created for HOBO-485.

## Acceptance Mapping

| Acceptance | Evidence |
|---|---|
| Register lists limitation, affected persona, user-visible impact, workaround, owner, and follow-up issue when needed | `KNOWN_LIMITATIONS_REGISTER` and `validateKnownLimitationsRegister` enforce those fields for every entry |
| Entries map to release notes, support scripts, docs, and launch messaging | `handoffTargets` require `release-notes`, `support-scripts`, `docs-portal`, and `launch-messaging` |
| Scope-out items cannot be marketed as supported v1 capability | `classifyScopeOutClaim` rejects supported-v1 wording for known scope-out phrases |
| Register has beta and GA review checkpoints | `reviewCheckpoints` requires beta and GA gates that block stale publication |

## Gates

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\known-limitations-register-contract test
```

The package also carries architecture-guard evidence:

- `architecture/known_limitations_register.proto`
- `architecture/known_limitations_register.cue`
- `architecture/pacts/known_limitations_register.pact.json`
- `ARCHITECTURE.md`

## Scope Boundary

The proof does not publish final release notes, build the docs portal, implement
support tooling, approve GA claims, or create production support capability.
