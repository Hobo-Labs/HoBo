# Legal Privacy Private Beta Evidence Contract

HOBO-464 proof for the V1 Legal, Privacy & Terms Readiness M2 private beta
evidence gate.

## What This Proves

- Required M2 private beta evidence is listed and mapped to owning projects.
- Blockers and accepted risks are recorded with source evidence, disposition, and
  revisit expectations.
- Cross-project dependencies are reflected into the V1 release cutline instead
  of becoming hidden legal/privacy state.
- Follow-up issues are allowed only when tied to explicitly missing evidence.
- Parent release-readiness sync is required when the legal/privacy gate changes
  launch risk.

## Boundary

This package records private beta evidence and limitations. It does not draft
final customer terms, approve a privacy policy or DPA, implement legal workflow
software, enable billing or paid launch, make public compliance claims, or build
support tooling.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\legal-privacy-private-beta-evidence-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for this evidence
  record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
