# HOBO-64 Matching Engine Skeleton Proof

This executable proof pins the M1 matching engine skeleton from
[Plan 04](../../control-plane.md#plan-04),
[Plan 25](../../platform-engineering.md#plan-25), and
[ADR-0088](../../adr/01-architecture-core.md#adr-0088).

## Contract Surface

- The engine gathers only ResourceDefinitions of the requested resource type.
- Context criteria filter candidates before scoring and record rejected candidates.
- Ranking uses the HOBO-55 specificity vector and deterministic definition-id tiebreaks.
- True ties are surfaced with a tie flag and tied candidate ids.
- The emitted `match.Decided` payload carries the winner, full ranking, rejections,
  objective placeholder, tie status, and `sha256:` catalog content hash.

## Proof Boundaries

This proof intentionally does not implement hard `require` capability filtering,
PlanRejected emission, objective ranking, Dispatcher maximize-credits behavior, or
mapping-as-sugar compilation. Those remain owned by later matching, policy, and
dispatcher slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\matching-engine-skeleton-contract test
```

The checks live in
`src/draft/technical-proofs/matching-engine-skeleton-contract/test/matching-engine.test.ts`.
