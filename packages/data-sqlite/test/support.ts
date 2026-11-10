import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	EngineBinding,
	EngineConformanceResult,
	EngineHarness,
} from "@hobo/data-core";
import { createSqliteEngine, SQLITE_SCHEMA_FIXTURE } from "../src/index.js";

export const NOW = "2026-11-10T00:00:00.000Z";

/** A directory under the OS temp dir, removed by the returned function. */
export function tempDir(prefix: string) {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One file-backed SQLite store per binding, each in its own temp directory. */
export function sqliteHarness(): EngineHarness {
	const dirs = new Map<EngineBinding, () => void>();
	let counter = 0;
	return {
		schemaFixture: SQLITE_SCHEMA_FIXTURE,
		create() {
			counter += 1;
			const { dir, remove } = tempDir("hobo-sqlite-conf-");
			const binding = createSqliteEngine({
				path: path.join(dir, `store-${counter}.db`),
				clock: () => NOW,
			});
			dirs.set(binding, remove);
			return binding;
		},
		dispose(binding) {
			dirs.get(binding)?.();
			dirs.delete(binding);
		},
	};
}

export function failures(results: readonly EngineConformanceResult[]): string {
	return results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}
