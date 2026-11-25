# Docs Portal Scope Contract

This package is the executable M0 proof for HOBO-434. It records the accepted
Docs Portal productization scope, validates the required persona/scope boundary
shape, and guards against implementation creep into portal UI, CMS, search,
analytics, support tooling, security intake, hosting, or marketing publication.

The authoritative design record is
[`docs/design/docs-portal.md`](../../../../../docs/design/docs-portal.md).
Branch evidence is summarized in
[`docs/design/proofs/hobo-434-docs-portal`](../../../../../docs/design/proofs/hobo-434-docs-portal/README.md).

## Proof

Run the focused proof with:

```powershell
pnpm --prefix src\draft\exp-proofs\docs-portal-scope-contract test
```

The tests prove:

- user/business goal and primary personas are explicit;
- scope in/out, non-goals, and operating boundaries are recorded;
- dependencies map to DX, release notes, compatibility, launch claims, support,
  security, accessibility, and verification sources;
- owning initiative boundaries are named without taking adjacent scope;
- docs portal content areas are listed before M1 contract work;
- M1 evidence requirements are listed with owner, source, proof mode, and claim;
- follow-up M1-M4 work is blocked until M0 acceptance;
- excluded UI, CMS, search service, analytics, support automation, security
  intake, hosting, and public-claim scope is rejected by the validator.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Docs Portal
  Scope Contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
