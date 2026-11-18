import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
	generateDrizzleMigration,
	toDataMigrationPlan,
} from "@hobo/adapter-drizzle";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonText,
} from "@hobo/data-core";
import {
	createPostgresEngine,
	type PostgresExecutor,
	type PostgresParameter,
	type PostgresRow,
} from "@hobo/data-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { executeDataMigration } from "../src/migration-executor.js";

const before = pgTable("users", {
	id: integer().primaryKey(),
	email: text(),
});
const after = pgTable("users", {
	id: integer().primaryKey(),
	email: text(),
	name: text().notNull(),
});

const pact = parseJsonText(
	readFileSync(
		new URL(
			"../../adapters/adapter-drizzle/contracts/pacts/schema-diff-engine.pact.json",
			import.meta.url,
		),
		"utf8",
	),
);
if (
	!isJsonObject(pact) ||
	!isJsonArray(pact.interactions) ||
	pact.interactions.length === 0
)
	throw new Error("Drizzle migration pact must contain interactions");
const interactions = pact.interactions.map((interaction) => {
	if (
		!isJsonObject(interaction) ||
		!isJsonString(interaction.description) ||
		interaction.providerState !== "users with two existing email addresses" ||
		!isJsonObject(interaction.request) ||
		!isJsonString(interaction.request.backfillSql) ||
		!isJsonArray(interaction.request.legacyConsumers) ||
		!interaction.request.legacyConsumers.every(isJsonString) ||
		!isJsonObject(interaction.response)
	)
		throw new Error("Drizzle migration pact interaction is malformed");
	return {
		description: interaction.description,
		backfillSql: interaction.request.backfillSql,
		legacyConsumers: interaction.request.legacyConsumers,
		response: interaction.response,
	};
});

function postgresExecutor(database: PGlite): PostgresExecutor {
	async function query(
		client: PGlite | Transaction,
		sql: string,
		parameters: readonly PostgresParameter[] = [],
	) {
		const result = await client.query<PostgresRow>(sql, [...parameters]);
		return {
			rows: result.rows,
			rowCount: result.affectedRows ?? result.rows.length,
		};
	}
	function transactionExecutor(
		client: Transaction,
		depth: number,
	): PostgresExecutor {
		return {
			query: (sql, parameters) => query(client, sql, parameters),
			async transaction(body) {
				const savepoint = `hobo_test_${depth}`;
				await client.exec(`SAVEPOINT ${savepoint}`);
				try {
					const result = await body(transactionExecutor(client, depth + 1));
					await client.exec(`RELEASE SAVEPOINT ${savepoint}`);
					return result;
				} catch (error) {
					await client.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
					throw error;
				}
			},
		};
	}
	return {
		query: (sql, parameters) => query(database, sql, parameters),
		transaction: (body) =>
			database.transaction((client) => body(transactionExecutor(client, 0))),
	};
}

describe("Drizzle migration consumer contract", () => {
	let database: PGlite;
	beforeAll(async () => {
		database = new PGlite();
		await database.waitReady;
	});
	afterEach(async () => {
		await database.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
	});
	afterAll(async () => {
		await database.close();
	});
	for (const interaction of interactions)
		it(interaction.description, async () => {
			const initial = await generateDrizzleMigration({
				current: {},
				desired: { users: before },
			});
			for (const statement of initial.statements)
				await database.exec(statement.sql);
			await database.exec(
				'INSERT INTO "users" ("id", "email") VALUES (1, \'a@example.test\'), (2, \'b@example.test\')',
			);
			const artifact = await generateDrizzleMigration({
				current: { users: before },
				desired: { users: after },
				backfills: {
					"backfill:users:backfill-column:name": interaction.backfillSql,
				},
			});
			const plan = toDataMigrationPlan({
				plan: artifact.plan,
				emitted: artifact.statements,
				migrationId: "users-v2",
				verify: {
					afterBackfill: 'SELECT "id" FROM "users" WHERE "name" IS NULL',
				},
			});
			const engine = createPostgresEngine({
				executor: postgresExecutor(database),
				schemaTables: ["users"],
				capture: false,
			});
			if (!engine.schema)
				throw new Error("PostgreSQL schema port is unavailable");
			const result = await executeDataMigration({
				port: engine.schema,
				plan,
				replayErasures: () => 0,
				compatGate: () => ({
					gateId: "users-readers",
					consumersOnLegacySchema: interaction.legacyConsumers,
					verifiedAt: new Date().toISOString(),
				}),
			});
			const columns = await database.query<{ column_name: string }>(
				"SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY column_name",
			);
			const rows = await database.query<{ value: JsonObject }>(
				'SELECT row_to_json("users") AS value FROM "users" ORDER BY "id"',
			);
			expect({
				status: result.status,
				dualWindowOpen: result.dualWindowOpen,
				columns: columns.rows.map((row) => row.column_name),
				rows: rows.rows.map((row) => row.value),
			}).toEqual(interaction.response);
			if (result.snapshot) await engine.dropSchemaSnapshot(result.snapshot);
		});
});
