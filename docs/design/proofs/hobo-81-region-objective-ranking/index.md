# HOBO-81 Region Objective Ranking Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04), [PLAN-25](../../platform-engineering.md#plan-25), and [ADR-0033](../../adr/01-architecture-core.md#adr-0033).

The branch adds `src/draft/technical-proofs/region-objective-ranking-contract`, an independent executable POC for the Planner step that applies region and colocation constraints before objective ranking.

It proves:

- Two `full` candidates tied on specificity and priority resolve by the configured objective.
- Switching the objective from `cost` to `latency` changes the winner predictably.
- The `carbon` objective ranks by carbon intensity and records the objective rationale.
- Colocated resources land in a shared allowed region.
- Conflicting region/colocation constraints fail closed with a precise rejection.
- Missing cost signals degrade deterministically to the next objective signal instead of inventing cost data.
- True objective ties fall through to the stable definition id, set `tie`, and replay to identical events.
- Cross-provider colocated edges are penalized by the `single-provider` objective and recorded in the ranking rationale.
- The `cost` objective ranks by effective cost, including cross-region/provider egress cost when supplied.
- The selected objective and ranking rationale are emitted in `match.Decided` and `deployment.Planned` metadata.

Scope kept out: `maximize-credits`/CreditLedgerView routing, live cost solvers, provider cost data sourcing, capability negotiation internals, and real provider/IaC realization.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\region-objective-ranking-contract test
```
