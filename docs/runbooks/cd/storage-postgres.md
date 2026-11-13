---
type: Runbook
title: "HoBo.CD runbook: PostgreSQL journal"
description: "The multi-node fenced EventStore. Assembled from the Runbook section of packages/storage-postgres/README.md."
tags: [hobo, cd, runbook, storage-postgres]
---

# HoBo.CD runbook: PostgreSQL journal

The multi-node fenced EventStore. This page is assembled from the **Runbook** section of `packages/storage-postgres/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

**Provision.** Use PostgreSQL 16+ and a dedicated database role that owns one
schema per store (`HOBO_STORE_POSTGRES_SCHEMA`). Size `max_connections` to
`replicas × poolSize + replicas`: one extra connection per replica for `LISTEN`.

**First start / upgrade.** Every replica migrates on start, under a
transaction-scoped advisory lock keyed by the schema. Exactly one applies;
the others wait and then see the result. A failed migration rolls back
completely. Roll replicas forward; never run an older build against a newer
schema (`schema-ahead`).

**Readiness.** `store.health()` reports `server-version` and `schema-version`
checks. Wire it into the service readiness probe (WP12).

**`unavailable` / `statement-timeout` spikes.**

1. Check `hobo.storage.postgres.errors{failure}`.
2. In `pg_stat_activity`, look for sessions `idle in transaction` or holding
   locks on `<schema>.streams` or `<schema>.partition_head`.
3. Commands were not committed. Callers retry with the same idempotency keys,
   and dedupe makes the retry safe.

**`migration-drift`.** Someone edited an applied migration or the
`schema_migrations` row. Restore the shipped file. Never update the checksum
by hand. A real schema change is a new numbered migration.

**A reconciler replica died holding a Camp.** No action is needed. Its lease
expires after `leaseTtlMs`, another replica claims with a higher fence and
resumes from `loadCheckpoint`. The dead holder's late writes are refused
(`STALE_FENCE`). To hand over sooner, an operator may `resetCheckpoint` (an
audited `reset` entry in `checkpoint_log`). Never edit `subscription_leases`
by hand, because fence tokens must only increase.

**Audit a handover.** Inspect the subscription's checkpoint log:

```sql
SELECT entry, kind, position, fence_token, holder_id, committed_at
FROM <schema>.checkpoint_log
WHERE subscription_id = $1 AND partition_id = $2
ORDER BY entry;
```

`advance` positions strictly increase, and the fence never falls.

**Backups / restore.** Use ordinary `pg_dump`/PITR of the schema. After a
restore to an earlier point, running consumers see `CHECKPOINT_REGRESSION` or
`STALE_FENCE` and must re-claim. That is the intended fail-closed behaviour.
