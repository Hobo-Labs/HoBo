# `src/` — PostgreSQL DurableEventStore

| File | Role |
|---|---|
| `store.ts` | `createPostgresEventStore`: append/commit, reads, snapshots, fold and quarantine, live wake, and the subscription surface wired through transactions with retry and metrics. |
| `subscriptions.ts` | Lease claim, renew and release, checkpoint commit and reset, and the checkpoint log. Each runs under the lease row lock. |
| `effects.ts` | Staging durable effects inside the commit transaction. |
| `migrate.ts` | The migration runner: server-version gate, advisory lock, checksum and schema-ahead refusals. |
| `migrations/` | The numbered migrations ([README](migrations/README.md)). |
| `config.ts` | Parse configuration (proto JSON, or env) into `PostgresStoreConfig`. |
| `parse.ts` | Parse event inputs and append options at the boundary. Enforces `EVENTSTORE_LIMITS`. |
| `rows.ts` | Decode rows into `EventEnvelope`s. Unknown codecs and invalid JSON are typed failures. |
| `errors.ts` | `StoragePostgresError`, remediation, and translation of SQLSTATE and errno values. |
| `telemetry.ts` | The metric sink shape and fire-and-forget emission. |
| `ids.ts`, `identifiers.ts`, `pg.ts` | Event ids from positions, schema names and channels, and the thin driver seam (`PgPoolLike`). |
| `_generated/` | protoc-gen-es output for `data-models/storage_postgres.proto`. Never edit it by hand. |

The lock order is always the stream row, then `partition_head`, then effect
rows, so concurrent commits cannot deadlock. Lease operations lock only their
own lease row.

## Runbook

See the package [README Runbook](../README.md#runbook). For code changes,
keep every SQL statement schema-qualified through `quoteSchema`, and never
read the server clock in SQL: timestamps come from the injected `Clock`.
