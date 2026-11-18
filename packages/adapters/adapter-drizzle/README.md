# `@hobo/adapter-drizzle`

This adapter converts PostgreSQL Drizzle schemas into HoBo's canonical
`SchemaIr`, computes an expand/backfill/contract migration plan, and generates
SQL with the bundled `drizzle-kit` 0.31.11 toolchain. It uses `drizzle-orm`
0.44.7 for SQL generation. The plan records the toolchain version.

```ts
import * as current from "./schema-current.js";
import * as desired from "./schema-next.js";
import { generateDrizzleMigration, toDataMigrationPlan } from "@hobo/adapter-drizzle";

const artifact = await generateDrizzleMigration({
  current,
  desired,
  backfills: {
    "backfill:users:backfill-column:name":
      'UPDATE "users" SET "name" = "email" WHERE "name" IS NULL',
  },
});
const migration = toDataMigrationPlan({
  plan: artifact.plan,
  emitted: artifact.statements,
  migrationId: "users-v2",
  verify: { afterBackfill: 'SELECT "id" FROM "users" WHERE "name" IS NULL' },
});
```

`generateDrizzleMigration` accepts schema module exports for the current and
requested states. Provide SQL for every `backfill-column` step, using `stepKey`
to form its key; unexpected or empty backfills are rejected. The returned
`statements` carry their plan steps in execution order. `sqlDigest` binds the
plan digest and every statement, including caller-supplied backfills. It changes
when that SQL changes even if the schema plan remains the same. The caller owns
reviewing and executing the SQL and managing transaction boundaries.

The generator rejects schemas with impedance findings, unsupported Drizzle
snapshot features, uncovered schema changes, or missing SQL. It replaces
Drizzle Kit's primary-key removal placeholder with executable PostgreSQL that
looks up the existing constraint name. Changed indexes are dropped and recreated
in the contract phase. `@hobo/trails` can execute the resulting migration phases;
its transaction behavior depends on the selected schema-apply adapter.

`createDrizzleDiffEngine` remains available for synchronous canonical planning.
Its optional synchronous `emitSql` path requires a host-provided emitter and an
explicit `toolchainPresent: true`; use `generateDrizzleMigration` for bundled
asynchronous SQL generation. `ingestDrizzleSchema` can be used independently to
inspect a schema and its impedance findings without generating SQL.

| Export | Purpose |
|---|---|
| `ingestDrizzleSchema` | Produce a canonical schema and sorted impedance findings |
| `createDrizzleDiffEngine` | Create a canonical differ with an optional host SQL emitter |
| `generateDrizzleMigration` | Generate a plan, ordered SQL statements, and SQL digest |
| `toDataMigrationPlan` | Convert emitted statements into the phases consumed by `@hobo/trails` |
| `stepKey` | Identify a plan step for SQL and backfill matching |
| `DRIZZLE_ENGINE_ID`, `DEFAULT_DRIZZLE_ENGINE_VERSION` | Identify the pinned Drizzle toolchain |
| `DRIZZLE_IMPEDANCE_CODES`, `DrizzleImpedanceFinding` | Describe constructs outside the canonical schema |
| `DrizzleAdapterError`, `DRIZZLE_ADAPTER_ERROR_CODES` | Report input and SQL emission failures |

## Ingestion findings

Ingestion reads Drizzle's published structural metadata. It reports constructs
that the canonical schema cannot represent instead of silently treating the
result as complete. The SQL generator requires an empty findings list.

| Code | Meaning |
|---|---|
| `DRIZZLE_EXPORT_UNRECOGNIZED` | The export is not a Drizzle table |
| `DRIZZLE_VIEW_UNREAD` | A view has no canonical representation |
| `DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE` | The table uses a non-default PostgreSQL schema |
| `DRIZZLE_FOREIGN_KEY_UNREAD` | The table has inline foreign keys |
| `DRIZZLE_EXTRA_CONFIG_UNREAD` | Extra configuration could not be represented |
| `DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE` | An index uses a SQL expression |
| `DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE` | An index has a partial predicate |
| `DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE` | An index uses a non-default order, nulls order, or operator class |
| `DRIZZLE_INDEX_OPTIONS_UNREPRESENTABLE` | An index uses non-default access or storage options |
| `DRIZZLE_COLUMN_UNRECOGNIZED` | A column descriptor could not be read |
| `DRIZZLE_COLUMN_GENERATED_UNREPRESENTABLE` | A generated column cannot be represented |
| `DRIZZLE_COLUMN_IDENTITY_UNREPRESENTABLE` | An identity column cannot be represented |
| `DRIZZLE_COLUMN_TYPE_UNREADABLE` | A column has no readable SQL type |
| `DRIZZLE_NON_POSTGRES_TABLE` | A column belongs to a different SQL dialect |
| `DRIZZLE_DEFAULT_UNREPRESENTABLE` | A default is a SQL expression or runtime function |
| `DRIZZLE_TABLE_COLUMNS_EMPTY` | A table yielded no readable columns |
| `DRIZZLE_TABLE_NAME_DUPLICATE` | Multiple exports declare the same table name |

PostgreSQL `serial`, `smallserial`, and `bigserial` express their implicit
sequence defaults through the column type. Explicit runtime default functions
are reported as findings. Adding a serial column fills existing rows through its
sequence; no manual backfill is required.
Converting an existing column to or from a serial type is rejected because it
requires sequence changes that the canonical schema does not model.

The canonical schema currently describes PostgreSQL tables, columns, literal
defaults, single-column uniqueness and primary keys, and ordinary column
indexes. Foreign keys, check constraints, composite keys, expression and
partial indexes, enums, views, independent sequences, and non-default schemas
are outside that representation. Column order is not recorded. SQL generation
refuses detected features outside the representation rather than emitting a
partial migration. Integration tests execute representative migrations on
PostgreSQL through PGlite; they do not provision a remote database.
