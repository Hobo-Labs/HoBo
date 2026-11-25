---
type: Reference
title: "Capability matrix (derived)"
description: "How the 10x5 primitive x runtime coverage matrix is derived from registered Resource Definitions, bootstrap profiles, claim strategies, and trust evidence — and the honesty rules that keep packs, bridges, and sponsor-backed bootstraps out of the native-support count."
tags: [hobo, design, capabilities, portability, honesty]
---

# Capability matrix (derived)

> **Purpose.** Answer "which primitives can HoBo actually run on which runtimes,
> today, without a human account?" from the catalog itself.
> **Package:** [`@hobo/capability-matrix`](../../packages/capability-matrix/README.md).
> **Rule:** there is no 50-cell table to edit. Coverage changes when the catalog
> changes.

## The cell space

Ten Bindle primitives — `web`, `api`, `service`, `data`, `kv`, `bucket`,
`queue`, `topic`, `secretRef`, `webhook` — times five runtime models — `wasm`,
`oci`, `vm_iaas`, `paas`, `serverless_faas`. Both vocabularies come from
[`@hobo/capability-profiles`](../../packages/capability-profiles/README.md), so
the matrix cannot invent a cell or quietly lose one. Every cell always exists in
the output; an uncovered cell is an empty candidate list, not a missing key.

## The derivation chain

A candidate lands in a cell only if every link below resolves. Each link is an
input to the generator, never a lookup it performs itself.

1. **Resource Definition.** A registered product declares `semantics`: which
   capability profiles it implements, with what realization (`native`, `pack`,
   `bridge`), and which runtime models it runs on. A legacy definition without
   semantics makes no capability claim and contributes nothing.
2. **Profile registry.** The declared profile id must be registered; the profile
   is what maps the claim onto a Bindle primitive. An unregistered profile is
   excluded as `unregistered-profile` rather than guessed from the id.
3. **Bootstrap profile.** `bootstrapStrategyRef` resolves to a bootstrap class,
   which decides `publicProviderBootstrap`.
4. **Claim strategy.** `claimStrategyRef` resolves to an ownership-transition
   mode, which decides `providerNativeClaim`.
5. **Trust evidence.** `trustEvidenceRef` resolves to evidence that is still
   live at the caller-supplied instant. Missing or expired evidence removes the
   candidate from the cell.
6. **Conformance.** The profile implementation's conformance outcome caps the
   cell's maturity: `fail` is `rejected`, `unknown` is `watchlist`, and only a
   pass lets the provider class decide (`established` → `supported`,
   `verified-emerging` → `preview`, `experimental` → `experimental`).

The generator is pure: the evaluation instant is a parameter, so the same
catalog always produces the same bytes, and a coverage change is attributable to
a catalog event rather than to when the report ran.

## Honesty rules

These exist because the interesting failure is not an empty matrix, it is a full
one that means less than it looks like it means.

- **Packs and bridges are coverage, not native market support.** A pack is HoBo
  making a primitive work on a runtime that does not offer it; a bridge is HoBo
  translating to a neighbouring product. Both are counted, in their own columns,
  and neither is ever added to the native count.
- **Sponsor-backed is not anonymous.** Only `public-anonymous`, `proof-of-work`,
  `agent-self-registration`, and `wallet-funded` count as a public provider
  bootstrap. Sponsor-backed deployment works, but HoBo's budget pays for it, so
  it appears as its own `sponsorBacked` count. Reading it as anonymous coverage
  would turn a cost line into a capability claim.
- **A migrate or export claim path is not a provider-native claim.** If
  ownership only arrives by moving the workload somewhere else, the provider did
  not hand it over.
- **Stale evidence removes coverage rather than ageing it.** Evidence that
  expires at or before the evaluation instant fails closed. The candidate leaves
  the cell and is named in `staleExcluded`, so "we never covered this" and "our
  proof lapsed last week" never look the same.

## Reading the report

`validateCapabilityMatrix(matrix, { minimumStrategiesPerCell })` returns one
entry per cell:

| Field | Meaning |
|---|---|
| `total` | Every candidate in the cell, any realization |
| `directPublicProviderNative` | Native realization **and** public bootstrap **and** provider-native claim |
| `pack` | Candidates realized as a pack |
| `bridge` | Candidates realized as a bridge |
| `sponsorBacked` | Candidates whose bootstrap spends HoBo budget |
| `meetsMinimum` | `total` reaches `minimumStrategiesPerCell` |
| `meetsDirectMinimum` | `directPublicProviderNative` reaches `minimumDirectPerCell` (default 1) |

`shortfalls` names the cells that miss a minimum, one entry per cell per kind
(`total`, `direct-public-provider-native`), each carrying `have` and `required`.
A cell can meet the total minimum and still be a direct shortfall — that is
exactly the "covered by packs only" or "covered by sponsorship only" case, and
it is meant to be visible rather than smoothed over.

`staleExcluded` lists the candidates that would have counted if their evidence
were current. Read it before reading an empty cell as a gap in the market.

## Exports

- `toMatrixJson` — machine-readable, stable key order; suitable for committing
  as a snapshot and diffing in CI.
- `toMatrixCsv` — one row per candidate, for spreadsheet triage of coverage.
- `toMatrixMarkdown` — one row per primitive, one column per runtime, each cell
  summarised as counts by realization (`2 native / 1 pack`). Regenerate it;
  never hand-edit a rendered matrix back into the docs.

## Related

- [`live-provider-matrix.md`](./live-provider-matrix.md) — what the adapters
  actually do live today, which is a different question from what the catalog
  declares.
- [`authoring-resources-wiring.md`](./authoring-resources-wiring.md) — how the
  PortabilityReport scores provider escapes once a cell is covered.
