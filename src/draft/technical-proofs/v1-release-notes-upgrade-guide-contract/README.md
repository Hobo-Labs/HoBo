# V1 Release Notes Upgrade Guide Contract

HOBO-407 defines the v1 release notes and upgrade-guide outline before final release-candidate
evidence exists.

This POC records a machine-checkable M0 contract in `src/release-notes-upgrade-guide.ts`:

- `outline` pins the eight required release-note and upgrade-guide sections.
- `requiredInputs` maps release engineering, docs, bootstrap, compatibility, and support source
  projects to the sections they feed.
- `classifyMissingEvidence()` routes gaps to blocker candidates, follow-ups, or accepted substitute
  evidence.
- `canPublishReleaseNotes()` enforces that final release notes wait for release-candidate evidence.
- `validateReleaseNotesUpgradeGuide()` rejects unsupported compatibility guarantees.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\v1-release-notes-upgrade-guide-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for V1 Release Notes Upgrade Guide Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
