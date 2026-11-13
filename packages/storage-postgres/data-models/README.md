# `data-models/` — storage-postgres records

- `storage_postgres.proto`: `PostgresStoreConfigRecord`, `MigrationRecord`,
  `SubscriptionLeaseRecord`, `CheckpointLogRecord`, `CheckpointLogKind`, and
  `StoragePostgresErrorCode`. 64-bit positions and fences are decimal strings.
- `storage_postgres.cue`: constraints and defaults for the same records. The
  defaults mirror `CD_DEFAULTS` (plan 0024 A.6).
- `buf.yaml` opts the package into codegen (`pnpm run codegen --filter
  packages/storage-postgres`), which writes `src/_generated/storage_postgres_pb.ts`.

The domain `EventEnvelope` stays in `hobo.core.v1`. These records describe only
this store's configuration and ledger.

## Runbook

After editing the `.proto`, run codegen and commit the regenerated file.
`codegen:check` fails if they disagree. Keep the CUE ranges and the parser in
`src/config.ts` in step: the unit tests cover the parser's ranges.
