---
type: Runbook
title: "HoBo.CD runbook: Failover and rebalance"
description: "Governed failover and explicit rebalance. Assembled from the Runbook section of packages/cd/src/failover/README.md."
tags: [hobo, cd, runbook, failover]
---

# HoBo.CD runbook: Failover and rebalance

Governed failover and explicit rebalance. This page is assembled from the **Runbook** section of `packages/cd/src/failover/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **A region is down and nothing fails over.** Check the Camp's taints. Agents
  can never add NO_RUN, and the taint needs ≥ 2 signals, one of them
  Station-observed (WP22). Then check the node's tolerations: `toleration_ms`
  0 tolerates forever. Then check Rail `delivery.failover.automatic`. When it
  is off, `hobo deploy failover list --state PROPOSED` shows the proposal;
  approve it with `failover approve <id>`.
- **Only one failover runs at a time.** That is `max_concurrent` (default 1)
  per Station. The others stay PROPOSED and are admitted in proposal order.
- **REFUSED `failover-unsafe`.** The Bindle's database (or another data
  resource) lives in the failing Camp. Run a Trails replica handover (expand
  a replica reachable from the target, cut over, contract), then propose
  again with a new idempotency key.
- **ABANDONED.** The replacement failed or the grace expired. Both Camps are
  intact and the source was never purged. Inspect the replacement promotion
  named on the record before retrying.
- **The old Camp recovered.** Nothing happens automatically, by design. To
  move work back, run `hobo deploy rebalance <pipeline> <node>` (authorized).
  Moves run GRACEFUL under the node's fan-out limit.
