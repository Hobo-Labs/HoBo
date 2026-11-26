# HOBO-472 Launch Site Release Candidate Evidence

HOBO-472 is proven by the focused M3 contract at
[`src/draft/exp-proofs/cx/launch-site-release-candidate-evidence-contract`](../../../../src/draft/exp-proofs/cx/launch-site-release-candidate-evidence-contract/README.md).

## Evidence Summary

- Required release-candidate launch-site evidence is mapped to Launch Site, Example Apps, Release
  Program, Release Notes, Legal/Privacy, Support, and Dogfood Yard owners.
- Blockers and accepted risks are explicit: GA/public launch claims remain blocked on HOBO-479, and
  reference fixtures stay labeled instead of becoming production-readiness claims.
- Cross-project dependencies feed the release cutline across documentation, productization,
  operations-readiness, release-cutline, legal, and support domains.
- Follow-up records point only to missing GA launch-site handoff evidence.
- Parent release-readiness sync is required for the M3 gate while public GA launch claims remain
  blocked until M4 evidence exists.

## Negative Coverage

- Launch-site implementation scope creep is rejected.
- Final public copy publication is rejected.
- Release-candidate demo assets cannot publish GA readiness claims.
- Follow-up issues against accepted evidence are rejected.
- Malformed evidence collections return parser errors instead of throwing.

## Verification

```powershell
pnpm.cmd --dir src\draft\launch-site-release-candidate-evidence-contract test
```

The package also carries protobuf, CUE, and PACT boundary artifacts under its `architecture/`
directory for architecture-guard coverage.
