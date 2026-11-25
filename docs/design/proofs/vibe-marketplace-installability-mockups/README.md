---
type: Reference
title: "Vibe Marketplace Installability Mockups Proof"
description: "Source issue: HOBO-546."
tags: [hobo, design]
---

# Vibe Marketplace Installability Mockups Proof

HOBO-546 creates deterministic M1 marketplace browse, search, listing-detail, and installability mockups for the v1 vibe example chain. The executable proof lives in `src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups`.

## Acceptance Evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Mockups or wireframes cover app developer, workspace admin, marketplace operator, security reviewer, and support operator perspectives. | `VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS.personas` pins all five personas; each persona appears in at least one wireframe with operating questions. |
| Listing fixtures include visible state, evidence source, owner route, customer-safe message, org-catalog disposition, and proof mode. | `fixtures` cover preview-only, limited-beta, installable, policy-blocked, deprecated, and yanked states with the required fixture fields. |
| Target package path is `src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups`. | `packagePath` parser assertion and package-local tests pin the target path. |
| Target proof path is `docs/design/proofs/vibe-marketplace-installability-mockups/README.md`. | `proofPath` parser assertion pins this proof note. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `scenarioPaths`, `accessibilityNotes`, and Pact/CUE fixtures require happy, blocked, stale-or-unknown-evidence, support-handoff, live, simulated, reference fixture, and scope-out labels. |

## Scope Boundaries

This proof does not build a live storefront, Registry storage, resolver, install runtime, ranking, monetization, publisher portal, policy engine, RBAC runtime, scanner, approval service, support tooling, launch publication, or customer-facing launch claim.

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups/test/vibe-marketplace-installability-mockups.test.ts
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups/architecture/proto/vibe_marketplace_installability_mockups.proto`
- CUE: `src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups/architecture/vibe_marketplace_installability_mockups.cue`
- Pact-style fixture: `src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups/architecture/pacts/vibe_marketplace_installability_mockups.pact.json`
