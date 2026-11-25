# Release Channels Scope POC

HOBO-431 proof for Release Channels M0 scope and acceptance.

## What This Proves

- Release Channels has an explicit user/business goal and four primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on release cutline, artifact provenance, compatibility matrix, release notes, beta feedback, support, and status-page/incident communication records.
- Owning initiative dependencies are mapped without moving deployment, artifact, compatibility, messaging, support, security, or publication runtime into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build release automation, deployment
promotion, artifact publication, compatibility runners, marketing pages, support ticket routing,
status-page publication, security attestation, or downstream implementation issues.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\release-channels-scope test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Release Channels Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
