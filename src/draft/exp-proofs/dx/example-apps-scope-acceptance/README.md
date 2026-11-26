# Example Apps Scope Acceptance POC

HOBO-435 proof for Example Apps M0 scope and acceptance.

## What This Proves

- Example Apps has an explicit user/business goal and four primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on the existing worked example, role walkthrough, DX command surface,
  authoring resource model, and ADR-0064 scope boundary.
- Owning initiative dependencies are mapped without moving launch demo, onboarding, support, or
  release-cutline work into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build example applications, create launch
marketing assets, provision cloud resources, or create downstream implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\example-apps-scope-acceptance test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Example Apps Scope Acceptance.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
