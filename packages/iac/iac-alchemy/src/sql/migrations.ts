import { DatabaseSync } from "node:sqlite";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Migrations from "@alchemy.run/sql/Migrations";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface DrizzleSchemaResourceInput {
	readonly id: string;
	readonly schema: string;
	readonly out?: string;
	readonly dialect?: Drizzle.Dialect;
	readonly breakpoints?: boolean;
}

export function declareDrizzleSchema(input: DrizzleSchemaResourceInput) {
	return Drizzle.Schema(input.id, {
		schema: input.schema,
		out: input.out ?? "./migrations",
		dialect: input.dialect ?? "postgres",
		...(input.breakpoints !== undefined
			? { generate: { breakpoints: input.breakpoints } }
			: undefined),
	});
}

export function createMigrationsConfig(
	input: Migrations.MigrationsInput,
	priorTable?: string,
): Migrations.ResolvedMigrations {
	const normalized = Migrations.normalizeMigrationsInput(input);
	return Migrations.resolveMigrations({
		input: normalized,
		stamped: { table: priorTable },
	});
}

const nodeFsPathLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

export async function inspectDrizzleMigrationsDir(dir: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const layout = yield* Migrations.detectLayout(dir);
			const records = yield* Migrations.readMigrationRecords(dir);
			return {
				layout,
				table: Migrations.ALCHEMY_DEFAULT_TABLE,
				records,
			};
		}).pipe(Effect.provide(nodeFsPathLayer)),
	);
}

export function createNodeSqliteMigrationExecutor(
	db: DatabaseSync,
): Migrations.SqlExecutor {
	return {
		dialect: "sqlite",
		query: (sql, params) =>
			Effect.try({
				try: () => {
					const rendered =
						params !== undefined && params.length > 0
							? Migrations.inlineSqlParams(sql, params, "sqlite")
							: sql;
					const trimmed = rendered.trimStart().toUpperCase();
					const stmt = db.prepare(rendered);
					if (
						trimmed.startsWith("SELECT") ||
						trimmed.startsWith("PRAGMA") ||
						trimmed.startsWith("WITH")
					) {
						return stmt.all().map((row) => ({ ...row }));
					}
					stmt.run();
					return [];
				},
				catch: (cause) =>
					new Migrations.MigrationError({
						message: cause instanceof Error ? cause.message : String(cause),
						cause,
					}),
			}),
		batch: (statements) =>
			Effect.try({
				try: () => {
					db.exec("BEGIN");
					try {
						for (const statement of statements) {
							const trimmed = statement.trim();
							if (trimmed.length > 0) {
								db.exec(trimmed);
							}
						}
						db.exec("COMMIT");
					} catch (cause) {
						db.exec("ROLLBACK");
						throw cause;
					}
				},
				catch: (cause) =>
					new Migrations.MigrationError({
						message: cause instanceof Error ? cause.message : String(cause),
						cause,
					}),
			}),
	};
}

export async function runDrizzleMigrationsOnSqlite(options: {
	readonly db: DatabaseSync;
	readonly migrations: Migrations.MigrationsInput;
	readonly priorTable?: string;
}) {
	const normalized = Migrations.normalizeMigrationsInput(options.migrations);
	const executor = createNodeSqliteMigrationExecutor(options.db);
	return Effect.runPromise(
		Migrations.runMigrations({
			input: normalized,
			stamped: { table: options.priorTable },
			withExecutor: (apply) => apply(executor),
		}).pipe(Effect.provide(nodeFsPathLayer)),
	);
}

export { DatabaseSync, Drizzle, Migrations };
