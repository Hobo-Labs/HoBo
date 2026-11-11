/**
 * The DDL the stores still carry in their initialisation code, read from source.
 *
 * Until the stores apply migrations themselves, that embedded DDL is what
 * creates the schema in production, and `db/schema.ts` is its declared source.
 * Two things keep them from drifting:
 *
 * - `db/migrations/embedded-ddl.lock.json` lists every embedded DDL statement
 *   that names a `hobo_ci_` object, wherever under `src/` it is. A test
 *   recomputes the list from source on every run, with no database, and fails
 *   when a statement was added, removed or reworded.
 * - The lock is only written by `db:verify`, which first proves on a real
 *   PostgreSQL that the embedded DDL and the migrations build identical
 *   catalogs. So a lock that matches the source is a statement that this exact
 *   DDL was proven equivalent to the migrations.
 *
 * Statements are read with the TypeScript parser rather than a regular
 * expression over the file: a string literal is a string literal wherever the
 * formatter puts it.
 */

import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type TypeScript from "typescript";
import { z } from "zod";
import { serializeJson, sha256Hex } from "./journal.js";

export const EMBEDDED_DDL_LOCK_CONTRACT = "hobo.ci.embedded-ddl-lock/v1";

const DDL =
	/\b(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE|DROP\s+(TABLE|INDEX))\b/iu;
const RELAY_OBJECT = /\bhobo_ci_\w+/u;
const CREATED_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/iu;

const Lock = z.object({
	contract: z.literal(EMBEDDED_DDL_LOCK_CONTRACT),
	provenOn: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	statements: z.array(
		z.object({ source: z.string().min(1), sql: z.string().min(1) }),
	),
});

export type EmbeddedDdlLock = z.infer<typeof Lock>;
export type EmbeddedStatement = EmbeddedDdlLock["statements"][number];

export interface EmbeddedDdlSource {
	/** The package root, as a directory URL; `src/` under it is what is read. */
	readonly packageRoot: URL;
	/** `db/migrations/`, where the lock lives. */
	readonly directory: URL;
}

// Loaded through `require` so a test runner that transforms ES imports does
// not try to transform the compiler itself.
const ts: typeof TypeScript = createRequire(import.meta.url)("typescript");

function literalText(node: TypeScript.Node): string | undefined {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isTemplateExpression(node))
		return [
			node.head.text,
			...node.templateSpans.map((span) => `\${…}${span.literal.text}`),
		].join("");
	return undefined;
}

/** Hand-written TypeScript under `src/`, sorted; generated trees are skipped. */
async function sourceFiles(packageRoot: URL): Promise<string[]> {
	const entries = await readdir(new URL("src/", packageRoot), {
		recursive: true,
	});
	return entries
		.map((entry) => `src/${entry.replaceAll("\\", "/")}`)
		.filter(
			(file) =>
				file.endsWith(".ts") &&
				!file.endsWith(".d.ts") &&
				!/(^|\/)_generated[^/]*\//u.test(file),
		)
		.sort();
}

/**
 * Every string literal under `src/` that is PostgreSQL DDL for a relay object,
 * in source order. The whole tree is read rather than a list of known files, so
 * DDL added in a new file is found the same way as DDL added to an old one.
 * The SQLite stores' DDL names no `hobo_ci_` object and is left out by that.
 */
export async function readEmbeddedDdl(
	source: EmbeddedDdlSource,
): Promise<EmbeddedStatement[]> {
	const statements: EmbeddedStatement[] = [];
	for (const file of await sourceFiles(source.packageRoot)) {
		const location = new URL(file, source.packageRoot);
		const text = await readFile(location, "utf8");
		if (!RELAY_OBJECT.test(text) || !DDL.test(text)) continue;
		const parsed = ts.createSourceFile(
			fileURLToPath(location),
			text,
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (node: TypeScript.Node): void => {
			const literal = literalText(node);
			if (
				literal !== undefined &&
				DDL.test(literal) &&
				RELAY_OBJECT.test(literal)
			)
				statements.push({
					source: file,
					sql: literal.replace(/\s+/gu, " ").trim(),
				});
			else ts.forEachChild(node, visit);
		};
		visit(parsed);
	}
	return statements;
}

/** The tables the embedded DDL creates, sorted. */
export function embeddedTableNames(
	statements: readonly EmbeddedStatement[],
): string[] {
	return [
		...new Set(
			statements.flatMap((statement) => {
				const name = CREATED_TABLE.exec(statement.sql)?.[1];
				return name === undefined ? [] : [name];
			}),
		),
	].sort();
}

function lockLocation(source: EmbeddedDdlSource): URL {
	return new URL("embedded-ddl.lock.json", source.directory);
}

/** Written by `db:verify` only, after the equivalence proof has passed. */
export async function renderEmbeddedDdlLock(
	source: EmbeddedDdlSource,
	provenOn: string,
): Promise<{ readonly location: URL; readonly text: string }> {
	const statements = await readEmbeddedDdl(source);
	return {
		location: lockLocation(source),
		text: serializeJson({
			contract: EMBEDDED_DDL_LOCK_CONTRACT,
			provenOn,
			sha256: sha256Hex(JSON.stringify(statements)),
			statements,
		}),
	};
}

/**
 * Every way the embedded DDL has moved since it was last proven equivalent to
 * the migrations. Empty means the proof still describes the source.
 */
export async function checkEmbeddedDdlLock(
	source: EmbeddedDdlSource,
): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(lockLocation(source), "utf8");
	} catch {
		return ["db/migrations/embedded-ddl.lock.json is missing; run db:verify"];
	}
	const lock = Lock.parse(JSON.parse(text));
	const current = await readEmbeddedDdl(source);
	const describe = (statement: EmbeddedStatement): string =>
		`${statement.source}: ${statement.sql}`;
	const locked = new Set(lock.statements.map(describe));
	const live = new Set(current.map(describe));
	const problems = [
		...current
			.filter((statement) => !locked.has(describe(statement)))
			.map(
				(statement) => `embedded DDL not in the lock: ${describe(statement)}`,
			),
		...lock.statements
			.filter((statement) => !live.has(describe(statement)))
			.map(
				(statement) => `locked DDL no longer in source: ${describe(statement)}`,
			),
	];
	if (
		problems.length === 0 &&
		lock.sha256 !== sha256Hex(JSON.stringify(current))
	)
		problems.push(
			"embedded DDL statements were reordered since the lock was written",
		);
	return problems;
}
