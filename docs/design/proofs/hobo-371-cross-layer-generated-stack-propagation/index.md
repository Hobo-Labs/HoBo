# HOBO-371 Cross-layer Generated-stack Propagation Proof

This proof covers the generated-stack verification path from
[PLAN-23](../../generated-stack.md#plan-23), [ADR-0037](../../adr/01-architecture-core.md#adr-0037),
[ADR-0048](../../adr/03-data-plane.md#adr-0048), [ADR-0055](../../adr/03-data-plane.md#adr-0055),
and [ADR-0056](../../adr/03-data-plane.md#adr-0056).

The executable contract lives in
`src/draft/technical-proofs/cross-layer-generated-stack-propagation-contract` and proves:

- A WIT `SupportTicket.priority` domain-record change regenerates and gates data,
  business, message, intelligence, and UI artifacts.
- Deterministic generated regions persist as reviewable, region-scoped diffs.
- Non-deterministic intelligence/UI paths and unsafe auto-heal paths degrade to
  proposed human-gated diffs without mutating source.
- A `hobo codegen --check` style drift check fails on hand edits in any generated
  region and leaves the drifted source unchanged.

Scope deliberately excludes the production per-layer engines and the `ui-render`
runtime. This proof owns only the cross-layer verification contract.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-layer-generated-stack-propagation-contract test
```
