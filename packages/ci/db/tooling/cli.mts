/**
 * `pnpm run db:<command>` for a relay package.
 *
 *   db:generate [--name <words>]  write the next migration from db/schema.ts
 *   db:ship                       rewrite src/_generated-assets/schema-migrations.ts
 *                                 from db/migrations (db:generate does this too)
 *   db:check                      fail if migrations, schema, embedded DDL or the
 *                                 shipped migrations disagree
 *   db:migrate                    apply pending migrations to HOBO_CI_MIGRATE_URL
 *   db:verify                     prove embedded DDL == migrations on HOBO_TEST_POSTGRES_URL,
 *                                 then refresh the embedded-DDL lock
 *
 * Run from the package directory; `--source` names its `db/source.ts`.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import {
	applyMigrations,
	checkEmbeddedDdlLock,
	checkMigrations,
	checkShippedMigrations,
	generateNextMigration,
	loadMigrationSet,
	proveEquivalence,
	type RelaySchemaSource,
	renderEmbeddedDdlLock,
	renderShippedMigrations,
} from "./index.js";

interface SourceModule {
	readonly schemaSource?: RelaySchemaSource;
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		source: { type: "string", default: "db/source.ts" },
		name: { type: "string", default: "" },
	},
});
const command = positionals[0];
const sourceModule: SourceModule = await import(
	pathToFileURL(resolve(process.cwd(), values.source)).href
);
const source = sourceModule.schemaSource;
if (source === undefined)
	throw new Error(`${values.source} does not export schemaSource`);

function requireUrl(variable: string): string {
	const url = process.env[variable];
	if (!url) throw new Error(`${variable} must name a PostgreSQL database`);
	return url;
}

/** Writes the migrations the package ships to its hosts, from db/migrations. */
async function ship(source: RelaySchemaSource): Promise<void> {
	const shipped = await renderShippedMigrations(source);
	await writeFile(shipped.location, shipped.text);
	console.log(
		`${source.scope}: wrote src/_generated-assets/schema-migrations.ts (${shipped.migrations} migrations)`,
	);
}

function report(title: string, lines: readonly string[]): void {
	console.log(`${title}${lines.length === 0 ? " none" : ""}`);
	for (const line of lines) console.log(`  - ${line}`);
}

if (command === "generate") {
	const generated = await generateNextMigration(source, values.name);
	if (generated === undefined) {
		console.log(`${source.scope}: db/schema.ts has no changes to migrate`);
	} else {
		const { entry } = generated;
		console.log(
			`${source.scope}: wrote ${entry.sql.file} (${entry.plan.steps.length} plan steps, ${entry.sql.statements} statements, plan ${entry.plan.digest})`,
		);
		report(
			"impedance (not carried by the canonical IR):",
			entry.impedance.map((finding) => `${finding.code}: ${finding.detail}`),
		);
		report(
			"fallback bindings:",
			entry.fallbacks.map(
				(fallback) => `${fallback.statement} -> ${fallback.boundTo}`,
			),
		);
		await ship(source);
		console.log(
			"Mirror the change in the embedded DDL, then run db:verify against a real PostgreSQL.",
		);
	}
} else if (command === "ship") {
	await ship(source);
} else if (command === "check") {
	const problems = [
		...(await checkMigrations(source)),
		...(await checkEmbeddedDdlLock(source)),
		...(await checkShippedMigrations(source)),
	];
	report(`${source.scope}: problems:`, problems);
	if (problems.length > 0) process.exitCode = 1;
} else if (command === "migrate") {
	const pool = new Pool({
		connectionString: requireUrl("HOBO_CI_MIGRATE_URL"),
		max: 1,
	});
	try {
		const result = await applyMigrations(
			pool,
			await loadMigrationSet(source.directory),
		);
		report(`${result.scope}: applied:`, result.applied);
		report(`${result.scope}: already applied:`, result.alreadyApplied);
	} finally {
		await pool.end();
	}
} else if (command === "verify") {
	const proof = await proveEquivalence(requireUrl("HOBO_TEST_POSTGRES_URL"), {
		migrations: await loadMigrationSet(source.directory),
		initializeEmbedded: source.initializeEmbedded,
	});
	console.log(
		`${source.scope}: compared ${proof.factsCompared} catalog facts on PostgreSQL ${proof.serverVersion}`,
	);
	report("differences, embedded DDL vs migrations:", proof.differences);
	report("justified differences:", proof.justified);
	report(
		"catalog changes from migrating an existing database:",
		proof.existingCatalogChanges,
	);
	report(
		`tables whose rows changed (${proof.rowsPreserved} rows seeded):`,
		proof.existingDataChanges,
	);
	report("applied on a second run:", proof.reapplied);
	const failed =
		proof.differences.length +
		proof.existingCatalogChanges.length +
		proof.existingDataChanges.length +
		proof.reapplied.length;
	if (failed > 0) {
		process.exitCode = 1;
	} else {
		const lock = await renderEmbeddedDdlLock(
			source,
			`PostgreSQL ${proof.serverVersion}`,
		);
		await writeFile(lock.location, lock.text);
		console.log("equivalent; wrote db/migrations/embedded-ddl.lock.json");
	}
} else {
	throw new Error("usage: cli.mts <generate|ship|check|migrate|verify>");
}
