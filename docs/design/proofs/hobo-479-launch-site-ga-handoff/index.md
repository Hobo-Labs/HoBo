# HOBO-479 Launch Site GA Handoff Evidence

HOBO-479 is proven by the focused M4 contract at
[`src/draft/exp-proofs/cx/launch-site-ga-handoff-evidence-contract`](../../../../src/draft/exp-proofs/cx/launch-site-ga-handoff-evidence-contract/README.md).

## Evidence Summary

- Required GA handoff evidence is mapped to Launch Site, Example Apps, Release Program, Release
  Notes, Support, Legal/Privacy, and Dogfood operations owners.
- Blockers and accepted risks are explicit: in-progress release-candidate source evidence remains
  an accepted risk, and public launch copy/site publication remains owner reviewed.
- Cross-project dependencies feed the release cutline across documentation, productization,
  operations-readiness, support, legal/privacy, and release-cutline domains.
- Follow-up records point only to missing final public-copy owner review evidence.
- Parent release-readiness sync is required for the M4 gate while public GA launch claims remain
  guarded by owner review.

## Negative Coverage

- Public launch-site implementation is rejected.
- Final launch copy, final visual assets, screenshots, or final demo video creation is rejected.
- Real cloud resource provisioning or production hosting is rejected.
- GA production-readiness claims require accepted GA handoff evidence and owner review.
- Malformed evidence collections return parser errors instead of throwing.

## Verification

```powershell
pnpm.cmd --dir src\draft\launch-site-ga-handoff-evidence-contract test
```

The package also carries protobuf, CUE, and PACT boundary artifacts under its `architecture/`
directory for architecture-guard coverage.
