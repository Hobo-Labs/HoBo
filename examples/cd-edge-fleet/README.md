# HoBo.CD for a retail edge fleet

This example ships a point-of-sale release to hundreds of store Camps
without ever hitting every store at once (ADR-0182: D20, D21, D23).

- **Camp set and Placement.** `retail-stores` selects prod Camps labelled
  `fleet=retail`. The `all-stores` placement takes every eligible Camp and
  spreads across all four regions. It evaluates residency against declared
  Yard regions only, because a store's own claims can narrow placement but
  never grant it (I19). A pilot group of at most 8 stores is formed first.
- **Fan-out.** `PROGRESSIVE_PER_GROUP` runs one group at a time, with at most
  10 % of the decision in flight. The pilot must succeed before any other
  group starts. More than 5 % failures halts the fan-out and rolls back the
  failed stores. An unreachable store is *deferred*, never failed, and
  catches up through `AUTO_PROMOTION_MATCH_NODE` when it returns.
- **Quorum.** Anything downstream of `stores` sees the Freight as available
  once 95 % of the decision qualifies.
- **Failover.** The Rail opts in, one failover at a time. A failover needs two
  independent signals, one of them Station-observed. It runs as a GRACEFUL
  saga: the source store is purged only after its replacement qualifies.
  Nothing fails back automatically.

The 400-Camp journey (`features/hobo-cd-fleet.feature`) and the fan-out
conformance suite exercise exactly these semantics.

## Run

```sh
pnpm --filter @hobo/example-cd-edge-fleet test
hobo deploy pipeline apply --file examples/cd-edge-fleet/src/hobo.delivery.ts
hobo deploy placement decide all-stores --pipeline pos --node stores
hobo deploy fanout show <fanout-id>
```

## Runbook

- **The fan-out is `HALTED`.** Failures went over the 5 % budget, and the
  failed stores have been rolled back. Read `fanout show` for the reasons.
  Fix the release, then `hobo deploy fanout resume` (a governed action), or
  roll back the whole fan-out with `hobo deploy fanout rollback`.
- **Stores are `deferred`.** They were `NO_PLACE`-tainted, unreachable or in
  a closed window when their turn came. They do not count as failures, and
  they catch up when they return. Check them with
  `hobo deploy camp show <store>`.
- **`placement-unsatisfiable`.** Fewer than four regions have an eligible
  store, for example because a region is fully tainted. Untaint the stores
  or lower `min_groups` in a reviewed change.
- **A failover is `PROPOSED` and does not run.** Another failover is already
  using the Rail's `max_concurrent: 1`, or only the agent reported the
  failure. Approve it with `hobo deploy failover approve`, or wait.
