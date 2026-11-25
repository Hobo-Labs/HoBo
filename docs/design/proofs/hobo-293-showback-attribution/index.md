# HOBO-293 Showback Attribution Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05)
and [ADR-0039](../../adr/02-identity-security.md#adr-0039).

The branch adds
[`src/draft/technical-proofs/showback-attribution-contract`](../../../../src/draft/technical-proofs/showback-attribution-contract/README.md),
an independent POC for attributing `MeteringView` cost facts across tenant,
Camp, Bindle, run, agent, and team showback rows. It consumes retained source
events from a seq-pinned MeteringView and emits run-inspector cost annotations
without building billing, invoicing, dashboard UI, shared-resource allocation,
or the MeteringView fold.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Fixture log produces showback breakdown that sums consistently at every hierarchy level | `rolls MeteringView costs up tenant -> Camp -> Bindle -> run and traces source events` |
| Per-agent showback isolates that agent's spend | `isolates per-agent showback without hiding tenant totals` |
| Cost annotations attach to run inspector | `attaches cost annotations to run-inspector rows with MeteringView evidence` |
| Numbers trace back to source events | `rolls MeteringView costs up tenant -> Camp -> Bindle -> run and traces source events` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Ambiguous/multiple owning principal has defined attribution rule | `keeps ambiguous owner facts at the known hierarchy and records the attribution rule` |
| Cost shared across two Bindles defers to shared-resource adversarial slice | `defers shared-resource cost across Bindles instead of inventing a split` |
| Deleted/renamed team preserves historical attribution | `uses stable historical team identifiers across team rename metadata` |
| Rounding so children don't sum to parent | `reconciles rounded presentation costs so children sum to the parent` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\showback-attribution-contract test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
npm.cmd test
```
