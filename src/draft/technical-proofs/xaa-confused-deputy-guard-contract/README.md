# XAA Confused-Deputy Guard Contract

HOBO-250 proof package for the outbound Cross-App Access confused-deputy guard.

The package models the broker-fronting seam that:

- derives `subject.delegatedBy` from a verified delegation principal instead of trusting caller input;
- emits `policy.Decided` before any ID-JAG mint attempt;
- denies by default unless a grant matches agent, user, target, and requested scopes;
- calls the existing outbound XAA broker only after the pre-mint policy decision allows; and
- emits `token.Denied` for forged delegation, missing verified delegation, and cross-target grant reuse.

It deliberately does not implement production IdP verification, policy-pack storage, authorization-server integration, inbound XAA validation, or scope inference.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\xaa-confused-deputy-guard-contract test
```

Covered behaviors:

- verified user delegation mints an ID-JAG and records `policy.Decided` before `token.Granted` and `token.Used`;
- forged `subject.delegatedBy` is rejected before ID-JAG minting or target authorization-server calls;
- a target with no matching delegated grant is denied before minting;
- an Asana grant cannot be reused to mint for Slack; and
- missing `verifiedDelegatedBy` fails closed; and
- a non-user verified delegation principal fails closed before minting.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Xaa Confused Deputy Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
