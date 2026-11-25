# Cross-Camp Routing Policy Contract

Independent proof for HOBO-151. It models the Yard-level DNS routing policy
step that runs after domain validation and staged cutover have produced
candidate Camps.

## Contract Surface

- `routeCrossCampTraffic()` builds the DNS record set for `failover`,
  `weighted`, `latency`, and `geo` policies.
- Every route change emits `domain.RoutingChanged` with selected Camps and the
  reason traffic moved.
- Failover flips only after sustained active-Camp health failure and only to a
  validation-cleared, healthy target.
- Weighted routing preserves the declared split across validation-cleared Camps.
- Latency and geo policies choose the nearest healthy validation-cleared Camp.

## Proof Boundaries

This proof consumes validated target facts, health samples, and Camp metadata.
It does not implement the DNS validation gate, staged/canary cutover,
cost-routing eligibility, Junction federation, concrete DNS adapters, or the
health-signal source.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-camp-routing-policy-contract test
```

The checks cover weighted record emission and target validation, sustained
failover, validation-gate refusal, transient health blip hysteresis, latency
selection, and geo fallback.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cross Camp Routing Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
