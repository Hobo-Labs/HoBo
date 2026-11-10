// Shared pieces of the conformance lanes: the fixed instant, the failure
// formatter, and the harness that gives every case its own in-memory store.
import type {
	EngineBinding,
	EngineConformanceReport,
	EngineHarness,
} from "@hobo/data-core";
import {
	createMemoryMongoExecutor,
	createMongoEngine,
	type MongoExecutor,
} from "../../src/index.js";

export const NOW = "2026-11-10T00:00:00.000Z";

/** Per-case results that did not pass, one per line, for an assert message. */
export function failures(report: EngineConformanceReport): string {
	return report.results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}

/** `pass=…, fail=…` — the per-status counts of a report. */
export function tally(report: EngineConformanceReport): string {
	const counts = new Map<string, number>();
	for (const result of report.results) {
		counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
	}
	return [
		...[...counts].map(([status, count]) => `${status}=${count}`),
		`skipped=${report.skipped.length}`,
	].join(", ");
}

export interface MemoryHarnessOptions {
	readonly capture?: boolean;
	/** Wrap each fresh executor, e.g. to observe or to interfere. */
	readonly wrap?: (executor: MongoExecutor) => MongoExecutor;
}

/** A fresh in-memory executor behind every binding. */
export function memoryHarness(
	options: MemoryHarnessOptions = {},
): EngineHarness {
	return {
		create(): EngineBinding {
			const executor = createMemoryMongoExecutor();
			return createMongoEngine({
				executor: options.wrap?.(executor) ?? executor,
				...(options.capture === undefined
					? undefined
					: { capture: options.capture }),
			});
		},
	};
}
