# Tutorials & Walkthroughs Scope Acceptance POC

HOBO-436 proof for Tutorials & Walkthroughs M0 scope and acceptance.

## What This Proves

- Tutorials & Walkthroughs has an explicit user/business goal and five primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on the role walkthrough, worked example, DX command surface, Example Apps, Workspace & Onboarding UX, and ADR-0064.
- Owning initiative dependencies are mapped without moving Docs Portal, Example Apps, onboarding, support workflow, launch assets, or cutline work into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build the docs portal, final tutorials, example applications, launch marketing assets, live cloud resources, or downstream implementation issues.

## Verification

```powershell
pnpm --prefix src\draft\exp-proofs\tutorials-walkthroughs-scope-acceptance test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by `scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Tutorials & Walkthroughs Scope Acceptance.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
