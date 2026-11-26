# Vibe Marketplace Installability Mockups

This proof package satisfies HOBO-546 with deterministic marketplace browse, search, listing detail, and installability reference mockups. It stays inside `src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups` and does not implement a live storefront, Registry storage, resolver, install runtime, ranking, monetization, publisher portal workflow, policy engine, RBAC runtime, scanner integration, support tooling, or launch claims.

## Proof

- `src/vibe-marketplace-installability-mockups.ts` parses the reference mockup bundle and exposes customer-safe installability summaries.
- `test/vibe-marketplace-installability-mockups.test.ts` proves the accepted personas, surfaces, listing states, quickstart fixture references, accessibility notes, and scope guards.
- `architecture/proto/vibe_marketplace_installability_mockups.proto` defines the boundary messages first.
- `architecture/vibe_marketplace_installability_mockups.cue` pins listing fixture fields, proof modes, quickstart references, scenario paths, and accessibility notes.
- `architecture/pacts/vibe_marketplace_installability_mockups.pact.json` gives marketplace consumers a Pact-style response without importing production runtime code.

Run the focused proof:

```bash
pnpm --dir src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups test
```

## Design Alignment

- `docs/design/marketplace-ux.md`: mockups preserve accepted listing states and installability outcomes.
- `docs/design/marketplace-publisher-trust-evidence.md`: preview and trust wording cannot overstate installability.
- `docs/design/capability-review-approval.md`: installable, limited-beta, yanked, and review ownership stays with review evidence.
- `docs/design/org-catalogs.md`: workspace visibility and policy-blocked states consume catalog disposition without implementing catalog storage.
- HOBO-577: quickstart fixture ids and proof-mode labels are cited before this proof renders marketplace behavior.

## Audience And Friction

The mockups serve app developers, workspace administrators, marketplace operators, security reviewers, and support operators. The friction they reduce is ambiguity around whether a listing is preview-only, limited beta, installable, policy-blocked, deprecated, or yanked, and who owns the next safe action.

## Scope Guards

`classifyMarketplaceMockupRequest` rejects live storefront, registry, resolver, install runtime, ranking, monetization, publisher workflow, policy/RBAC/scanner/approval service, support tooling, and launch-claim creep.
