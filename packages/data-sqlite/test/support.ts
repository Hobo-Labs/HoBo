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

export function tempDir(prefix: string) {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export const SQLITE_RESERVED_DATASET_NAMES = [
	"sqlite_sequence",
	"sqlite_master",
];

export function sqlitePositionPastHead(head: string): string {
	return String(Number(head) + 1_000_000);
}

export function sqliteHarness(): EngineHarness {
	const dirs = new Map<EngineBinding, () => void>();
	const files = new Map<EngineBinding, string>();
	let counter = 0;
	return {
		schemaFixture: SQLITE_SCHEMA_FIXTURE,
		reservedDatasetNames: SQLITE_RESERVED_DATASET_NAMES,
		positionPastHead: sqlitePositionPastHead,
		create() {
			counter += 1;
			const { dir, remove } = tempDir("hobo-sqlite-conf-");
			const file = path.join(dir, `store-${counter}.db`);
			const binding = createSqliteEngine({ path: file, clock: () => NOW });
			dirs.set(binding, remove);
			files.set(binding, file);
			return binding;
		},
		attach(binding) {
			const file = files.get(binding);
			if (file === undefined) {
				throw new Error("the binding was not created by this harness");
			}
			return createSqliteEngine({ path: file, clock: () => NOW });
		},
		dispose(binding) {
			dirs.get(binding)?.();
			dirs.delete(binding);
			files.delete(binding);
		},
	};
}

export function failures(results: readonly EngineConformanceResult[]): string {
	return results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}
