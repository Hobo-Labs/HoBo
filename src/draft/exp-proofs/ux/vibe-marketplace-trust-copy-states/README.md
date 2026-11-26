# Vibe Marketplace Trust Copy States

HOBO-547 pins the branch proof for marketplace trust warning, org-catalog filter,
deprecation, yank, and hidden-listing copy states. This package is an independent
M1 experience proof; it does not build marketplace UI, publisher portal UI,
approval services, scanners, policy engines, notification delivery, support queues,
or launch claims without evidence.

## Contract

The parser in
[`src/vibe-marketplace-trust-copy-states.ts`](./src/vibe-marketplace-trust-copy-states.ts)
turns an untrusted proof record into a parsed `MarketplaceTrustCopyStates` object.
It fails closed when a required fixture, proof mode, path, handoff owner, evidence
source, accessibility note, accepted HOBO-577 quickstart reference, or scope
boundary is missing.

The proof shape is mirrored by:

- [`architecture/vibe_marketplace_trust_copy_states.proto`](./architecture/vibe_marketplace_trust_copy_states.proto)
- [`architecture/vibe_marketplace_trust_copy_states.cue`](./architecture/vibe_marketplace_trust_copy_states.cue)
- [`architecture/pacts/vibe_marketplace_trust_copy_states.pact.json`](./architecture/pacts/vibe_marketplace_trust_copy_states.pact.json)

## Required Fixtures

| Scenario | Path | Proof mode | Owner route | Evidence source |
|---|---|---|---|---|
| `preview-warning` | `stale-or-unknown` | `reference-fixture` | Marketplace Publisher Trust Evidence | `docs/design/marketplace-publisher-trust-evidence.md` |
| `installable-with-evidence` | `happy` | `live` | Capability Review & Approval | `docs/design/capability-review-approval.md` |
| `policy-block` | `blocked` | `simulated` | Org Catalogs | `docs/design/org-catalogs.md` |
| `deprecated-guidance` | `stale-or-unknown` | `reference-fixture` | Registry Distribution | `docs/design/adr/07-portability-extensibility.md#adr-0062` |
| `yanked-support-route` | `support-handoff` | `simulated` | Support Workflow | `docs/design/support-workflow.md` |
| `hidden-listing` | `blocked` | `scope-out` | Marketplace UX | `docs/design/marketplace-ux.md` |

Each fixture carries customer-safe copy, an owner route, an evidence source, and
the complete accessibility note set:
`keyboard-only`, `focus-order`, `semantic-labels`, `contrast`,
`responsive-layout`, `reduced-motion`, `screen-reader-smoke`, and
`state-copy-clarity`.

## HOBO-577 Quickstart References

Marketplace copy states consume accepted resource-lifecycle quickstart fixture
ids instead of inventing install, policy, stale-evidence, or support behavior:

| Quickstart fixture | Proof mode | Copy state use |
|---|---|---|
| `rlq-collect-manifest-ir-v1` | `reference-fixture` | Preview warnings cite collected evidence before naming missing review limits. |
| `rlq-plan-safe-preview-v1` | `simulated` | Policy block wording reuses plan-preview boundaries without claiming a policy engine. |
| `rlq-deploy-run-accepted-v1` | `live` | Installable copy can cite accepted deploy evidence while requiring review links. |
| `rlq-manage-stale-evidence-v1` | `reference-fixture` | Deprecated guidance keeps stale evidence visible instead of implying current installability. |
| `rlq-recover-scope-out-v1` | `scope-out` | Yanked and hidden states reuse scope-out evidence for support and visibility limits. |

## Negative Guards

`classifyMarketplaceCopyClaim` rejects copy that overstates:

- security guarantees;
- popularity or ratings;
- installability or production readiness;
- registry guarantees;
- support readiness.

These refusals cover the HOBO-547 adversarial cases where marketplace wording
could imply security, popularity, installability, registry, or support guarantees
without linked evidence.

## Verification

Run the package test:

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states test
```

The root `pnpm-lock.yaml` keeps this proof package as a workspace importer so
frozen install checks include the HOBO-547 proof metadata.

The test suite proves fixture coverage, proof-mode coverage, happy/blocked/stale
evidence/support paths, support handoff summaries, scope-out enforcement, safe-copy
classification, HOBO-577 quickstart fixture references, and Pact/CUE artifact
alignment.

## Design Evidence

Branch evidence is summarized in
[`docs/design/proofs/vibe-marketplace-trust-copy-states/README.md`](../../../../../docs/design/proofs/vibe-marketplace-trust-copy-states/README.md).
