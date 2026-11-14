# `test/` — storage-postgres tests

| File | Covers |
|---|---|
| `unit.test.ts` | Runs without a server. Covers config parsing and `CD_DEFAULTS` parity, failure mapping and remediation, SQLSTATE translation, an unreachable server, ids, migration checksums, the old-server refusal, and live-lane selection. |
| `conformance.test.ts` | `@hobo/conformance` `runEventStoreConformance`, unmodified, with all eight assertions, including crash-mid-append atomicity (`support/append-crasher.ts` is SIGKILLed mid-stream). |
| `fence-two-process.test.ts` | Two OS processes: exactly one claims a Camp lease; a paused holder's appends, checkpoints and renewals are refused after takeover; concurrent appends get one winner per seq. |
| `lease-failover.test.ts` | §10 "Postgres lease holder dies": a SIGKILLed consumer is resumed by another process with no lost or duplicate checkpoint (from `checkpoint_log`), and a zombie's late checkpoint is refused. |
| `store.test.ts` | Positions, ids, conflicts, fencing, idempotency, filters, paging, effects, snapshots, durable quarantine, cross-instance live wake, limits, codec integrity, and the injected clock. |
| `subscriptions.test.ts` | Lease claim, expiry, release, renew, checkpoint and reset semantics, plus a concurrent-claim race. |
| `migrations.test.ts` | A concurrent first start, no-op restarts, drift, schema-ahead, an old server, and full rollback of a failing migration. |
| `concurrency.test.ts` | A position-paging reader never skips a concurrently committed event; per-stream seqs stay contiguous under contention. |
| `operations.test.ts` | Metrics through the sink, a failing sink, health, the statement-timeout failure, and use after close. |

`support/` holds the live lane (`postgres-lane.ts`, `global-setup.ts`), the
per-file helpers (`live.ts`: fresh schemas dropped after the file, a manual
clock), and the child-process store (`store-worker.ts`, `worker-process.ts`).

## Runbook

If a live suite reports `SKIPPED: …`, the reason names what is missing. Set
`HOBO_TEST_POSTGRES_URL`, start Docker, or install `postgresql-16`. As root,
the ephemeral cluster runs as the `postgres` user through `runuser`.
