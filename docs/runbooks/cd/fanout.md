---
type: Runbook
title: "HoBo.CD runbook: Fan-out"
description: "Group rollouts, failure budgets and halts. Assembled from the Runbook section of packages/cd/src/fanout/README.md."
tags: [hobo, cd, runbook, fanout]
---

# HoBo.CD runbook: Fan-out

Group rollouts, failure budgets and halts. This page is assembled from the **Runbook** section of `packages/cd/src/fanout/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **A fan-out is HALTED.** Run `hobo deploy fanout get <id>`. `reasons[0]`
  names the cause and `failed` lists the Camps. With `rollback_on_halt`, those
  Camps already have rollback promotions (`fanout:<id>:<camp>:rollback`). Fix
  the cause, then either `fanout resume <id>` (the budget restarts from the
  failures already counted) or `fanout rollback <id>`. A mandatory-group
  failure cannot be resumed past: roll back, or promote newer Freight.
- **Camps stay deferred.** Check `hobo deploy camp status <camp>`. A taint,
  `REACHABLE=false` or a closed window explains it. Deferred Camps catch up on
  their own once the cause clears. They never burn the failure budget.
- **Nothing moves.** `hobo.cd.fanout.in_flight` is flat and the stream does
  not grow. Another replica may hold `cd:fanout:<id>`; check the lease
  holder. Or an older fan-out of the node is still active and waiting for its
  group boundary (`hobo.cd.fanout.waiting` with reason `fanout-awaiting-supersede`).
- **`step_errors` rising.** A port (promotion service, inventory, windows) is
  failing transiently. Nothing is decided on an error. The next tick retries
  idempotently.
- **Departure kept data.** That is the `ORPHAN_DATA` default. `camp.Departed`
  lists the kept resources. Remove them deliberately, with a `DELETE` node
  departure or by hand.
