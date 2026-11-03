# @hobo/dispatcher

The Dispatcher (ADR-0071): deterministic, credit/budget-aware selection across
registered providers for placement (`match.Decided`), dispatch
(`dispatch.Decided`), and traffic (`traffic-backend` category — consumed by the
stations routing control loop).

- Ranks candidates by effective marginal cost against a pinned
  `CreditLedgerView@seq` (free tiers, rate/concurrency headroom, budget caps,
  switching cost, soonest-expiring credits).
- Hysteresis holds an incumbent unless savings clear a recorded threshold —
  never when the incumbent violates a budget hard constraint.
- Reservation ledger with CAS (`expectedSeq`) so concurrent dispatches cannot
  double-spend free headroom; reserve/confirm/release/expire emit
  `dispatch.Reservation*` facts.
- `replayDispatchDecision` replays identical inputs to a byte-identical
  decision fact.
- **`decideDispatchV2`** (schema `hobo.dispatcher/v2`) ranks registered providers
  by minimum incremental **billed** amount from `@hobo/pricing` quotes; v1
  `decideDispatch` is unchanged for credit ranking.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for evidence and
[`contracts/`](./contracts) for the PACT boundary.
