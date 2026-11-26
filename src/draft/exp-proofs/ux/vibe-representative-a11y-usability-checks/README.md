# Vibe Representative Accessibility And Usability Checks

Independent M2 experience proof for HOBO-565.

This package records representative accessibility and usability checks for the
vibe artifact family. It consumes the accepted HOBO-554 checklist and HOBO-577
quickstart fixtures, then maps onboarding, plan/diff, deployment dashboard,
marketplace, docs, support, publisher, and launch-demo artifacts to expected
evidence, severity, owner route, accepted-risk path, launch readiness impact,
and proof-mode labels.

## Contract Boundaries

- In scope: deterministic representative check fixtures, artifact-to-owner
  routing, quickstart fixture references, scenario paths, proof-mode labels, and
  scope-out guards.
- Source checklist: `docs/design/proofs/vibe-accessibility-usability-checklist/README.md`.
- Quickstart dependency: `docs/design/proofs/resource-lifecycle-quickstart-examples/README.md`.
- Consumed but not owned: product UI remediation, full audit execution,
  automated accessibility suite buildout, launch waiver approval, customer data,
  and public launch claims.

## Proof

```powershell
pnpm.cmd run test:file src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks/test/vibe-representative-a11y-usability-checks.test.ts
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Check fixtures cover onboarding, plan/diff, deployment dashboard, marketplace, docs, support, publisher, and launch-demo artifacts. | `REQUIRED_REPRESENTATIVE_ARTIFACTS` and `artifactChecks` pin all eight artifact rows. |
| Each check names expected evidence, severity, owner route, accepted-risk path, and launch readiness impact. | Every `RepresentativeCheckEvidence` row carries those fields, and validation rejects missing values. |
| Target package and proof paths are pinned. | `parseVibeRepresentativeA11yUsabilityChecks` rejects path drift from the issue target package and proof note. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarios` names all six paths and their required evidence and safe outcomes. |
| Source blocker artifacts are consumed without importing unmerged runtime code. | `sourceIssues` pins HOBO-554 and HOBO-577; `quickstartFixtureRefs` pins accepted quickstart fixture ids and consuming artifacts. |
| Scope out remains hard. | `classifyRepresentativeCheckRequest` rejects full audits, product UI remediation, automated suite buildout, waiver approval, customer data, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the
  representative check record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
