---
type: Design Proof Evidence
title: "HOBO-548 Vibe Publisher Portal Review Mockups Proof"
description: "M1 proof record for publisher submission, evidence upload, review, rejection, yank, and support handoff mockups."
tags: [hobo, proof, publisher-portal, marketplace, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-548 Vibe Publisher Portal Review Mockups Proof

This proof records branch evidence for publisher submission, evidence upload,
review status, rejection, resubmission, yanking, remediation, payout-readiness
handoff, and customer-safe support wording mockups.

## Evidence

- Source record: [`publisher-portal.md`](../../publisher-portal.md).
- Review source: [`capability-review-approval.md`](../../capability-review-approval.md).
- Trust source: [`marketplace-publisher-trust-evidence.md`](../../marketplace-publisher-trust-evidence.md).
- Payout source: [`marketplace-payout-hooks.md`](../../marketplace-payout-hooks.md).
- Catalog source: [`org-catalogs.md`](../../org-catalogs.md).
- Support source: [`launch-support-escalation.md`](../../launch-support-escalation.md).
- Quickstart source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Executable proof: [`vibe-publisher-portal-review-mockups`](../../../../src/draft/exp-proofs/ux/vibe-publisher-portal-review-mockups/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Mockups or wireframes cover publisher owner, maintainer, marketplace operator, security reviewer, support operator, and release owner perspectives. | `test/vibe-publisher-portal-review-mockups.test.ts` asserts every persona has a mockup with a concrete operating question. |
| Fixtures include artifact metadata, evidence state, review outcome, payout-readiness handoff, support wording, and customer-visible limitation state. | `fixtures` carry those fields and the parser rejects missing fixture metadata. |
| Package and proof path match the issue. | `parseVibePublisherPortalReviewMockups` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state and label. |
| Downstream publisher portal mockups consume accepted HOBO-577 quickstart fixture ids/proof-mode labels. | `quickstartFixtureRefs` pins `rlq-define-object-graph-v1`, `rlq-collect-manifest-ir-v1`, `rlq-manage-stale-evidence-v1`, `rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1`. |
| Scope-out work is refused. | `classifyPublisherPortalReviewMockupRequest` fails closed for publisher services, artifact hosting, Registry storage, payout implementation, scanners, production UI, support automation, customer data, and proofless launch claims. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into publisher
onboarding service work, artifact hosting, Registry storage, payout
implementation, security scanner or conformance runner implementation,
production portal UI, support tooling, customer-data access, or public launch
claims without evidence.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-publisher-portal-review-mockups test
```
