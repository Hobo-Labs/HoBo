# Vibe Publisher Portal Review Mockups

Independent M1 proof for HOBO-548.

This package records publisher submission, evidence upload, review status,
rejection, resubmission, yanking, remediation, payout-readiness handoff, and
support wording mockup contracts. It proves the publisher owner, publisher
maintainer, marketplace operator, security reviewer, support operator, and
release owner perspectives without building publisher onboarding services,
artifact hosting, Registry storage, payout execution, security scanners,
production portal UI, support tooling, customer-data access, or launch claims
without evidence.

## Contract Boundaries

- In scope: mockup records, fixture examples, publisher portal states, persona
  questions, scenario paths, proof-mode labels, accessibility notes, and
  fail-closed scope guards.
- Consumed but not owned: Publisher Portal, Capability Review & Approval,
  Marketplace Publisher Trust Evidence, Marketplace Payout Hooks, Org Catalogs,
  Launch Support Escalation, and accepted HOBO-577 Resource Lifecycle
  Quickstart fixture records.
- Out of scope: publisher onboarding service, artifact hosting, Registry
  storage, payout implementation, security scanner, production UI, support
  queue, customer data, and launch claims without evidence.

## Proof

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-publisher-portal-review-mockups test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Mockups or wireframes cover publisher owner, maintainer, marketplace operator, security reviewer, support operator, and release owner perspectives. | `mockups` map every persona to operating questions across submission, evidence upload, review status, rejection, resubmission, yank remediation, and payout/support handoff states. |
| Fixtures include artifact metadata, evidence state, review outcome, payout-readiness handoff, support wording, and customer-visible limitation state. | `fixtures` carry each required field and `validateVibePublisherPortalReviewMockups` rejects missing fields. |
| Target package and proof paths are pinned. | `parseVibePublisherPortalReviewMockups` rejects path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover all required states and labels. |
| Publisher portal mockups reuse the accepted HOBO-577 quickstart source instead of inventing product behavior. | `quickstartFixtureRefs` pins `rlq-define-object-graph-v1`, `rlq-collect-manifest-ir-v1`, `rlq-manage-stale-evidence-v1`, `rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1` with publisher-use notes and proof-mode labels. |
| Scope out remains hard. | `classifyPublisherPortalReviewMockupRequest` rejects publisher services, artifact hosting, payout implementation, scanners, production UI, support automation, customer-data access, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the mockup
  record. CUE uses the same lower-camel field names as the parsed TypeScript
  boundary.
- `architecture/pacts/` - Pact-style package boundary fixture that parses
  through `parseVibePublisherPortalReviewMockups`.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
