---
type: Proof
title: "Vibe Marketplace Discovery Prototype"
description: "Branch evidence for HOBO-562 deterministic marketplace discovery and install-intent prototype."
tags: [hobo, proof, marketplace, discovery]
---

# Vibe Marketplace Discovery Prototype

HOBO-562 proves the deterministic marketplace discovery and install-intent prototype as an M2
experience proof. The implementation package is
[`src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype`](../../../../src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype/README.md).

## Acceptance Evidence

| Acceptance | Branch proof |
|---|---|
| Prototype consumes M1 marketplace mockups and trust/org/deprecation/yank copy states. | Parser source checks require HOBO-546 mockup fixtures and HOBO-547 trust-copy fixtures before returning the branded prototype. |
| Fixture catalog includes listing state, trust evidence, org-catalog decision, support route, installability outcome, and proof mode. | `MARKETPLACE_DISCOVERY_PROTOTYPE.catalog` covers preview-only, limited-beta, installable, policy-blocked, deprecated, and yanked states with required fields. |
| Target package path is `src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype`. | Package path is pinned in parser tests. |
| Target proof path is `docs/design/proofs/vibe-marketplace-discovery-prototype/README.md`. | Proof note path is pinned in parser tests. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `paths`, `accessibilityNotes`, Pact, and CUE artifacts require all four paths plus live, simulated, reference fixture, and scope-out labels. |
| Scope out remains hard. | `classifyMarketplaceDiscoveryRequest` rejects live storefront, registry, resolver, install runtime, ranking, monetization, publisher workflow, production UI, support queue automation, and launch claims without evidence; `scopeOut` validation pins the same boundaries. |

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype test
```

The proof uses mocked fixture boundaries only. It does not build a live storefront, registry,
resolver, install runtime, ranking, monetization, publisher workflow, production UI, support queue,
or launch claims without evidence.
