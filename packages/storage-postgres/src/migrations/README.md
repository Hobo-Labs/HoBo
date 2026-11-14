# `src/migrations/` — schema migrations

Each migration is a numbered module (`NNNN_name.ts`) that exports `name` and
`sql(s)`, where `s` is the already-quoted schema identifier. `index.ts` lists
them in order and exports `SCHEMA_VERSION`.

Rules:

- The list is append-only. A released migration is never edited. Its checksum
  is stored in `<schema>.schema_migrations` and verified on every start, and
  `test/unit.test.ts` pins the checksums in a snapshot.
- A schema change is a new file with the next number. The snapshot changes by
  one appended entry.
- SQL must be valid inside one transaction (PostgreSQL DDL is transactional),
  so a failing migration leaves no trace.
- Timestamps are `text` written from the injected clock, never `now()`.

| Version | Name | Adds |
|---|---|---|
| 1 | `initial` | `partition_head`, `streams`, `events`, `snapshots`, `subscription_leases`, `subscription_checkpoints`, `checkpoint_log`, `queue_messages`, `durable_timers`, `cron_schedules`, `outbox` |

## Runbook

If startup fails with `migration-drift`, compare `schema_migrations.checksum`
with `migrationChecksum(MIGRATIONS[n])` from the running build. Restore the
shipped migration. Do not rewrite the stored checksum.
