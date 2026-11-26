# Vibe Marketplace Discovery Prototype

HOBO-562 proves a deterministic marketplace discovery and install-intent prototype over accepted
M1 marketplace fixtures. It composes:

- HOBO-546 marketplace browse/search/detail/installability mockups;
- HOBO-547 marketplace trust warning, org-catalog, deprecation, yank, and hidden-listing copy states;
- HOBO-577 resource-lifecycle quickstart fixture ids and proof-mode labels.

## Contract

`src/vibe-marketplace-discovery-prototype.ts` parses one untrusted prototype record into a branded
derived object. The parser fails closed when a catalog fixture lacks listing state, trust evidence,
org-catalog decision, support route, installability outcome, proof mode, source issue, accepted
fixture id, path coverage, accessibility note, or scope boundary.

Architecture artifacts mirror the parser shape:

- `architecture/proto/vibe_marketplace_discovery_prototype.proto`
- `architecture/vibe_marketplace_discovery_prototype.cue`
- `architecture/pacts/vibe_marketplace_discovery_prototype.pact.json`

## Fixture Catalog

| Fixture | Listing state | Intent outcome | Source proof |
|---|---|---|---|
| `mdp-preview-only-v1` | `preview-only` | Warning-only; install intent hidden. | HOBO-546 + HOBO-547 + HOBO-577 |
| `mdp-limited-beta-v1` | `limited-beta` | Beta-scoped intent with missing-evidence copy. | HOBO-546 + HOBO-547 + HOBO-577 |
| `mdp-installable-v1` | `installable` | Intent visible only with linked evidence. | HOBO-546 + HOBO-547 + HOBO-577 |
| `mdp-policy-blocked-v1` | `policy-blocked` | Intent suppressed with catalog/policy owner. | HOBO-546 + HOBO-547 + HOBO-577 |
| `mdp-deprecated-v1` | `deprecated` | Guidance-only migration/replacement route. | HOBO-546 + HOBO-547 + HOBO-577 |
| `mdp-yanked-v1` | `yanked` | Intent denied; support/migration only. | HOBO-546 + HOBO-547 + HOBO-577 |

## Scope Guards

`classifyMarketplaceDiscoveryRequest` rejects live storefront, registry, resolver, install runtime,
ranking, monetization, publisher workflow, production UI, support queue, and launch-claim expansion.
This package is a deterministic proof fixture, not product marketplace implementation.

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype test
```
