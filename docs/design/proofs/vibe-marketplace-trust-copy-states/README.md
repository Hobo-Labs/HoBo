---
type: Proof
title: "Vibe Marketplace Trust Copy States"
description: "Branch evidence for HOBO-547 marketplace trust warning, org-catalog filter, deprecation, yank, and hidden-listing copy states."
tags: [hobo, proof, marketplace, trust-copy]
---

# Vibe Marketplace Trust Copy States

HOBO-547 proves a marketplace trust-copy state register as an independent M1
experience proof. The implementation package is
[`src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states`](../../../../src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states/README.md).

## Acceptance Evidence

| Acceptance | Branch proof |
|---|---|
| Copy examples avoid overstating security, popularity, installability, registry guarantee, or support readiness. | `classifyMarketplaceCopyClaim` rejects those five overclaim families and the test suite asserts each refusal. |
| Fixtures cover preview warning, installable with evidence, policy block, deprecated guidance, yanked support route, and hidden listing. | `REQUIRED_MARKETPLACE_COPY_SCENARIOS` and `MARKETPLACE_TRUST_COPY_SCENARIOS` enumerate the six fixtures and `parseMarketplaceTrustCopyStates` fails closed if any are missing. |
| Reuse accepted HOBO-577 quickstart fixture evidence for downstream marketplace copy. | `quickstartFixtureRefs` pins `rlq-collect-manifest-ir-v1`, `rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`, `rlq-manage-stale-evidence-v1`, and `rlq-recover-scope-out-v1` with source issue, proof-mode labels, copy-state coverage, and marketplace trust-copy use notes. |
| Covers happy path, blocked path, stale or unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | Tests assert `happy`, `blocked`, `stale-or-unknown`, and `support-handoff` path coverage plus all proof modes: `reference-fixture`, `simulated`, `live`, and `scope-out`. |
| Preserve hard scope boundaries. | The parsed proof requires scope-out entries for production UI, publisher portal UI, approval service, security scanner, policy engine, notification delivery, support queue, and launch claims without evidence. |
| Prove the contract boundary, not a product UI. | The package includes TypeScript parser tests, protobuf shape, local CUE constraints, and a Pact-style mocked response fixture. |

## Fixture Register

| Fixture | State | Owner route | Evidence route |
|---|---|---|---|
| `mtc-preview-warning-v1` | `preview-only` | Marketplace Publisher Trust Evidence | `docs/design/marketplace-publisher-trust-evidence.md` |
| `mtc-installable-evidence-v1` | `installable` | Capability Review & Approval | `docs/design/capability-review-approval.md` |
| `mtc-policy-block-v1` | `blocked-by-policy` | Org Catalogs | `docs/design/org-catalogs.md` |
| `mtc-deprecated-guidance-v1` | `deprecated` | Registry Distribution | `docs/design/adr/07-portability-extensibility.md#adr-0062` |
| `mtc-yanked-support-route-v1` | `yanked` | Support Workflow | `docs/design/support-workflow.md` |
| `mtc-hidden-listing-v1` | `not-visible` | Marketplace UX | `docs/design/marketplace-ux.md` |

## Quickstart References

| HOBO-577 fixture | Proof mode | Copy states |
|---|---|---|
| `rlq-collect-manifest-ir-v1` | `reference-fixture` | `preview-warning` |
| `rlq-plan-safe-preview-v1` | `simulated` | `policy-block` |
| `rlq-deploy-run-accepted-v1` | `live` | `installable-with-evidence` |
| `rlq-manage-stale-evidence-v1` | `reference-fixture` | `deprecated-guidance` |
| `rlq-recover-scope-out-v1` | `scope-out` | `yanked-support-route`, `hidden-listing` |

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states test
```

The focused gate exercises the branch proof without live provider calls,
credentials, customer data, support queues, publisher portals, approval services,
or production marketplace UI.
