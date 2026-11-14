---
type: Runbook
title: "Fleet runbook: NATS server loss"
description: "What happens and what to do when one NATS server, the cluster quorum, or every server of a HoBo Fleet deployment is lost."
tags: [hobo, fleet, runbook, maintenance, nats]
---

# NATS server loss

**Signals:** `hobo_fleet_bus_status` from agents and the authority,
`hobo_fleet_claims_unreachable` from executors, NATS cluster health on the
monitoring port (bound to loopback on each server).

## One server of three

Clients reconnect to another server; streams stay available at three
replicas. Nothing is lost.

1. Find why the server stopped (host, disk, certificate expiry).
2. Restart it, or replace the host with the same cluster name, routes and
   certificate. Its stream replicas catch up from the others.
3. Verify the cluster reports three peers and every `FLEET_*` stream and
   `fleet-*` bucket has three current replicas.

## Quorum lost, or every server down

Claims and offers stop. The CI box, a dispatcher and executor, runs
standalone on the work it can see itself; GitHub's single assignment bounds
duplicate starts to idle sandboxes. Plain executors idle. Receipts queue on
disk in each agent and are published on reconnect, and the authority's
recorder catches up from the streams.

1. Restore quorum first: bring back servers with their data before replacing
   any. Never recreate a stream by hand; streams and buckets are created only
   by `hobo fleet ops provision`.
2. If the data of a majority is lost, rebuild the cluster empty, run
   `hobo fleet ops provision --replicas 3`, and let the authority rebuild the
   registry and views from its event store. In the high-availability profile
   the event store is `FLEET_JOURNAL` on this cluster, so this is a
   [restore](./backup-and-restore-drill.md).
3. Verify: agents report the bus up, `hobo fleet status` shows fresh
   observations, and the box is claiming its own offers again.

## Standalone profile

The single server is the bus. Its loss is the quorum case above; the event
store is SQLite on the authority host and is not affected.
