# S6-02 Control-Plane HA Contract

Independent draft POC for **HOBO-657**. Pins quorum event-store replication,
leader election, actor lease/fencing failover, and provider-resilience controls
per [`docs/design/reliability-observability-cost.md`](../../../../docs/design/reliability-observability-cost.md#plan-05).

## Requirements Source

- `docs/design/reliability-observability-cost.md#plan-05` — control-plane HA, actor leases + fencing, provider circuit breakers, retry budgets, bulkheads.
- `docs/archive/requirements/requirements.md` — **NFR-009** resume `< 30 s`; 99.9% control-plane availability.
- `src/draft/epic-proofs/reliability-observability-cost-finops/` — promoted Golden chaos / failover scenarios (consumed, not modified).

## Contract Surface

- `createQuorumEventStore(options)` — linearizable quorum-fenced append; rejects minority partitions and stale fences.
- `createLeaderElection(options)` — singleton leader leases with monotonic fence tokens.
- `runLeaderKillMidDeployChaos(input)` — chaos harness: kill Yard leader mid-deploy; follower resumes within NFR-009 without duplicate resource actions.
- `runAvailabilitySoak(input)` — computes control-plane availability against the 99.9% target.
- `evaluateProviderResilience(input)` — circuit breaker, retry budget, and bulkhead evaluation trace.

## Acceptance Mapping

| Issue acceptance | Executable evidence |
|---|---|
| Chaos test kills Yard leader mid-deploy; follower resumes within NFR-009 `< 30 s`. | `test/control-plane-ha-acceptance.test.ts` — leader-kill mid-deploy scenario |
| No duplicate resource actions; fencing verified. | stale-fence + duplicate-action rejection tests |
| 99.9% availability in soak lane. | availability soak test |
| Quorum replication + leader election. | quorum minority rejection + leader election tests |
| Provider resilience (circuit breakers, retry budgets, bulkheads). | `test/provider-resilience.test.ts` |

## Scope Boundary

This does **not** implement `packages/cloud`, `runtime-postgres`, or production Raft.
It is the executable contract slice those packages must satisfy via `@hobo/conformance`
quorum-fenced-append assertions.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s6-02-control-plane-ha-contract test
```

## Architecture Evidence

- `architecture/` — protobuf + CUE evidence for quorum append and failover outcomes.
- `architecture/pacts/` — PACT boundary fixture.
- `ADR.md` — parse-don't-validate and event-architecture notes.
