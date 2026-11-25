# `@hobo/adapter-drizzle`

drizzle-kit as HoBo's default relational schema-diff engine — with HoBo keeping
ownership of the plan.

Drizzle is a very good place to *author* a relational schema. It is not a good
place to keep the truth about one: its diffing lives in a CLI, its output is
SQL, and its version is not something a deployment artifact records. So this
adapter takes Drizzle as an **authoring surface** and converts it into the
canonical `SchemaIr` owned by `@hobo/core` (ADR-0160). Diffing then runs through
core's canonical differ, and the resulting `MigrationPlan` — expand / backfill /
contract, forward-only, destructive steps marked — is HoBo's artifact, not
drizzle-kit's.

## Surface

| Export | What it does |
|---|---|
| `ingestDrizzleSchema(moduleExports, options?)` | Structural ingestion of a Drizzle schema module into `{ schema: SchemaIr, impedance }` |
| `createDrizzleDiffEngine(options?)` | A `SchemaDiffEngine` whose `diff` delegates to core's `diffSchemaIr` and stamps `engineId`/`engineVersion` |
| `toDataMigrationPlanShape(input)` | Converts a plan + emitted SQL into the shape `@hobo/trails` executes |
| `DRIZZLE_ENGINE_ID`, `DEFAULT_DRIZZLE_ENGINE_VERSION` | `"drizzle-kit"` and the pinned toolchain version |
| `DRIZZLE_IMPEDANCE_CODES`, `DrizzleImpedanceFinding` | The closed vocabulary of things the IR could not carry |
| `DrizzleAdapterError`, `DRIZZLE_ADAPTER_ERROR_CODES` | The one error type this package throws |
| `stepKey(step)` | The canonical key used to pair a plan step with its emitted SQL |

```ts
import * as schema from "./db/schema.js";
import { createDrizzleDiffEngine, ingestDrizzleSchema } from "@hobo/adapter-drizzle";

const { schema: desired, impedance } = ingestDrizzleSchema(schema);
if (impedance.length > 0) {
	// Not a failure — a disclosure. Log it, show it, or gate on it.
	console.warn(impedance);
}

const engine = createDrizzleDiffEngine({ version: "0.31.1" });
const plan = engine.diff(currentIr, desired);
// plan.digest changes if the engine version changes, even with identical steps.
```

## No dependency on `drizzle-orm`

Ingestion is **structural**. This package does not import `drizzle-orm`; it
reads the shape Drizzle publishes — the `Symbol.for("drizzle:*")` registry
symbols on a table, and the plain properties (`name`, `columnType`, `notNull`,
`primary`, `isUnique`, `getSQLType()`) of a column descriptor. Those symbols are
registry symbols precisely so separately-installed copies of the ORM
interoperate, which makes them the honest thing to match on. The upside is that
no consumer of the schema-diff port inherits an ORM it does not use, and HoBo's
release train is not pinned to Drizzle's major version. The cost is stated
plainly under **HONEST SCOPE** below.

## Impedance is documented, never dropped

ADR-0144 makes impedance a first-class output. Every construct in the module is
either represented in the IR or named in `impedance` with a `code` and a
`detail`. There is no third bucket, and an unrecognized construct is never a
throw — a finding is the answer.

| Code | Meaning |
|---|---|
| `DRIZZLE_EXPORT_UNRECOGNIZED` | The export is not a Drizzle table (enum helper, relations object, plain value) |
| `DRIZZLE_VIEW_UNREAD` | A view export; the IR models tables only |
| `DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE` | The table names a non-default postgres schema; the IR has no schema qualifier |
| `DRIZZLE_FOREIGN_KEY_UNREAD` | Inline foreign keys exist; the IR has no foreign-key concept, so they are not diffed |
| `DRIZZLE_EXTRA_CONFIG_UNREAD` | A table's extra-config callback threw, or returned entries that are not readable index builders (composite primary keys, table-level unique constraints and check constraints land here, named by builder class) |
| `DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE` | An index keys on a SQL expression; the IR indexes declared columns only, so the index is **not ingested** |
| `DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE` | A partial index; it is ingested on its columns, without the `WHERE` predicate |
| `DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE` | An index key has a non-default sort order, nulls order or operator class; the index is ingested without it |
| `DRIZZLE_COLUMN_UNRECOGNIZED` | A value in the column map is not a column descriptor |
| `DRIZZLE_COLUMN_TYPE_UNREADABLE` | A column exposed no readable SQL type |
| `DRIZZLE_NON_POSTGRES_TABLE` | A column carries a MySQL/SQLite/SingleStore type; this adapter ingests postgres only |
| `DRIZZLE_DEFAULT_UNREPRESENTABLE` | The default is a SQL expression or a runtime function, not a literal |
| `DRIZZLE_TABLE_COLUMNS_EMPTY` | A table-shaped export yielded no readable columns, so no table was emitted |
| `DRIZZLE_TABLE_NAME_DUPLICATE` | Two exports declare the same SQL table; the first by export name wins |

## Fail closed: SQL emission is gated

`emitSql` requires the drizzle-kit toolchain, which this package does not
bundle. It is always present on the engine — so an absent toolchain reads as a
**refusal**, never as a missing capability a caller might route around — and it
throws `DrizzleAdapterError` with code `TOOLCHAIN_UNAVAILABLE` and remediation
text unless the host both sets `toolchainPresent: true` and wires an `emitSql`
emitter. A partial emission (fewer statements than plan steps) is refused with
`SQL_EMISSION_INCOMPLETE`. There is no best-effort SQL path anywhere in this
package: an approximated migration is a defect that only surfaces against a
production database.

## Parse, don't validate

`ingestDrizzleSchema` is this package's single parse boundary. It accepts an
untrusted bag of module exports (a plain record, or the module namespace object
`import * as schema` yields) and returns **derived types** — a `SchemaIr` as
parsed by core's `parseSchemaIr`, plus a frozen, sorted list of impedance
findings — rather than handing back the caller's objects with a boolean verdict
attached. Downstream code holds a checked `SchemaIr`, so there is no way to pass
an unparsed module where a schema is expected. Refusals carry a `code` and
remediation; nothing partially valid is ever returned. The protobuf and CUE
records in `data-models/` are the wire form of what the adapter reports; the
parsed types are narrowings of them.

Determinism is part of the parse contract: tables, columns, indexes, and
findings are all sorted by name (with a code-unit comparator, never
`localeCompare`, whose result depends on host ICU data), so the same module
ingested twice is deep-equal including ordering. That matters because
`MigrationPlan.digest` is a hash over the diff of these values.

## Event architecture

This package is pure and owns no aggregate: it holds no state, starts no actor,
and emits no event of its own. It sits underneath the migration flow. A
migration **command** enters `@hobo/trails`, whose migration-executor **actor**
appends `migration.Planned` / `migration.PhaseApplied` / `migration.Verified`
**events** into the durable **event store**; **projections** over that stream
build the **materialized views** the **read store** serves for current migration
status, and **snapshots** back that status without replaying the whole stream.
This adapter's contribution is the plan those events describe — the
`MigrationPlan` and its digest, which the events carry so an operator can see
exactly which engine version produced the SQL that ran.

## HONEST SCOPE

- **SQL emission is toolchain-gated and unimplemented here.** This package does
  not bundle or shell out to drizzle-kit. `emitSql` always throws
  `TOOLCHAIN_UNAVAILABLE` unless a host declares the toolchain present *and*
  passes its own emitter. No SQL is generated by this package, ever.
- **Ingestion is structural, not semantic.** It reads the shape Drizzle
  publishes today. It is not validated against every Drizzle release, and a
  future ORM refactor of those symbols would show up as
  `DRIZZLE_EXPORT_UNRECOGNIZED` findings rather than as a crash. That is the
  intended failure mode, but it is a failure mode.
- **The IR is narrower than Drizzle.** Foreign keys, check constraints,
  composite primary keys, table-level unique constraints, expression indexes,
  partial-index predicates, index key ordering, generated columns, enums, views,
  sequences, partitioning, and non-default postgres schemas have no
  representation in `SchemaIr` and therefore are **not diffed**. They appear as
  impedance findings when detected. A plan from this engine is not a complete
  description of a schema change involving those constructs.
- **An index is ingested in one of three ways, and each is disclosed.** Plain
  columns only: carried whole. Plain columns plus a `WHERE` predicate or a
  non-default key order: carried on its columns, with a finding naming what was
  left behind, so adding, dropping or re-keying it is still diffed but a change
  to only the predicate or the order is not. Any SQL-expression key: not carried
  at all, with a finding, because an index on `(a, lower(b))` recorded as an
  index on `(a)` would be a false statement about the schema. A host that emits
  SQL for such an index has no plan step to bind it to and must say where it put
  it; `@hobo/ci` binds it to the owning table's `create-table` step and records
  that in its migration journal.
- **Index access method, storage parameters and `CONCURRENTLY` are not read.**
  An index declared `USING gin` is ingested as an index on its columns with no
  finding. That is a silent loss this package still has.
- **Column ordinal position is not represented.** Columns are sorted by name for
  determinism, so a plan says nothing about physical column order.
- **Postgres only.** `dialect` accepts `"postgres"`; anything else is refused
  with `DRIZZLE_DIALECT_UNSUPPORTED`.
- **`toDataMigrationPlanShape` is a structural mirror**, not an import, of
  `@hobo/trails`'s `DataMigrationPlan`. Adapters may not depend on layer-3
  packages, so the two shapes are kept in sync by review rather than by the
  compiler.
- **The PACT file is documentation, not an executed verification.** This package
  is pure and exposes no HTTP surface; behavior is covered by the unit tests.

## Layering

`@hobo/adapter-drizzle` is a layer-2 adapter. It depends on `@hobo/core` and
nothing else in `@hobo/*` — not `@hobo/trails`, not `@hobo/data`, not
`@hobo/data-postgres`. Imports flow inward only.
