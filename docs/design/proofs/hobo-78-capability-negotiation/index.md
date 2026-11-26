# HOBO-78 Capability Negotiation Proof

This proof pins the M2 capability-negotiation behavior required by
[Plan 04](../../control-plane.md#plan-04),
[Plan 25](../../platform-engineering.md#plan-25), and
[ADR-0033](../../adr/01-architecture-core.md#adr-0033).

## Contract Surface

- Provider capability checks run after criteria matching and before final selection.
- `require` misses reject the candidate, not the whole plan when a later candidate satisfies it.
- `prefer` misses degrade with a `PlanWarning`, including `prefer + none`.
- A complete `require` miss across all candidates emits `deployment.PlanRejected` with
  `capability.require.unsatisfied`.
- Conflicting `require`/`prefer` requests for the same capability preserve fail-closed `require`
  semantics.

## Proof Boundaries

Author-time static feedback, objective ranking, concrete provider implementations, and the
Gatekeeper remain outside this slice.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\capability-negotiation-contract test
```

The draft proof package is
`src/draft/technical-proofs/capability-negotiation-contract`.
