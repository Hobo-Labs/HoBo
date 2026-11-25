# Vibe Accessibility Usability Checklist

Independent M1 experience proof for HOBO-554.

This package records the accessibility and usability checklist every downstream
vibe artifact must satisfy before it can be treated as useful launch evidence.
It maps v1 launch surfaces to required checks, evidence modes, owners, launch
severity, accepted-risk routes, and proof-mode labels without building product
UI, running a full audit, creating a broad automated suite, approving waivers,
using customer data, or making unsupported launch claims.

## Contract Boundaries

- In scope: checklist records, required check fixtures, surface-to-owner matrix,
  scenario paths, proof-mode labels, accepted-risk routes, and scope-out guards.
- Source baseline: `docs/design/accessibility-usability-launch-baseline.md`.
- Quickstart dependency: `quickstartFixtureRefs` pins the accepted HOBO-577
  fixture ids and proof-mode labels each launch surface consumes before this
  checklist can treat a vibe artifact as useful evidence.
- Consumed but not owned: workspace/onboarding, plan/diff, deployment
  dashboard, marketplace, publisher, docs, support, and release-cutline
  artifacts.
- Out of scope: product UI implementation, full accessibility audit execution,
  automated suite buildout, launch waiver approval, customer data, and launch
  claims without named evidence.

## Proof

```powershell
pnpm.cmd run test:file src/draft/exp-proofs/ux/vibe-accessibility-usability-checklist/test/vibe-accessibility-usability-checklist.test.ts
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Checklist covers keyboard, focus order, semantic structure, contrast, responsive layout, reduced motion, screen-reader smoke, state clarity, and copy clarity. | `REQUIRED_ACCESSIBILITY_CHECKS` and `checks` pin the ten required check ids and evidence modes. |
| Matrix maps every vibe surface to required checks, evidence mode, owner, launch severity, and accepted-risk route. | `surfaceChecklist` covers workspace/onboarding, plan/diff, deployment dashboard, marketplace, publisher portal, docs, admin/support, and release/support artifacts. |
| Downstream accessibility checks consume accepted HOBO-577 quickstart evidence. | `quickstartFixtureRefs` pins `rlq-define-object-graph-v1`, `rlq-collect-manifest-ir-v1`, `rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`, `rlq-inspect-event-projection-v1`, `rlq-manage-stale-evidence-v1`, `rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1`. |
| Target package and proof paths are pinned. | `parseVibeAccessibilityChecklist` rejects path drift from the issue target package and proof note. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof labels are covered. | `scenarios` names the six acceptance paths and their required evidence and safe outcomes. |
| Scope out remains hard. | `classifyChecklistRequest` rejects product UI remediation, full audit/certification, broad automated suite work, waiver approval, customer data, and unsupported launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the checklist
  record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
