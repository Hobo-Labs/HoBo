# V1 Beta Pilot Private Beta Evidence

HOBO-463 proves the M2 private-beta evidence gate for the V1 Beta Pilot & Feedback Loop project.

This POC records a machine-checkable M2 contract in
`src/v1-beta-pilot-private-beta-evidence.ts`:

- required private-beta evidence mapped to owning projects;
- blocker states and accepted risks represented as release evidence;
- cross-project dependencies reflected in the release cutline;
- follow-up issue specs created only for missing evidence;
- parent release-readiness signal changes only when launch risk changes.

The package does not onboard beta customers, build support tooling, or resolve blockers surfaced by
feedback. It only proves the evidence gate those downstream owners consume.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\v1-beta-pilot-private-beta-evidence test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the private-beta evidence gate.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
