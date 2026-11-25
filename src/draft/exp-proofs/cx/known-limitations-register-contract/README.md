# Known Limitations Register Contract

HOBO-485 proof for customer-facing known limitations and scope-out register.

## What This Proves

- Limitation records include limitation id, affected persona, user-visible
  impact, workaround, owner, and follow-up issue when needed.
- Entries map to release notes, support scripts, docs, and launch messaging.
- Scope-out or unsupported items cannot be marketed as supported v1 capability.
  Supported-capability wording wins over limited/unsupported framing when both
  appear in one claim, so mixed claims such as "unsupported environment is
  supported at v1" fail closed into the register.
- Beta and GA checkpoints require owner/customer-visible text review and block
  stale publication.
- Raw register input parses once into the `ParsedKnownLimitationsRegister`
  derived type before downstream projections consume it.
- The release-note view strips internal notes and preserves limitation state.

## Boundary

This package validates the M0 customer-facing limitation register. It does not
write final release notes, build a docs portal, publish launch pages, implement
support tooling, approve GA operational claims, or create production support
capability.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\known-limitations-register-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the limitation
  register.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate, parsed domain type, and
  event-architecture evidence.
