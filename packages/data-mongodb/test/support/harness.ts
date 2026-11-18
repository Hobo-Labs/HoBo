import type {
	EngineBinding,
	EngineConformanceReport,
	EngineHarness,
} from "@hobo/data-core";
import {
	createMemoryMongoExecutor,
	createMongoEngine,
	MONGO_CONFORMANCE_DECLARED_LIMITS,
	type MongoExecutor,
} from "../../src/index.js";

export const NOW = "2026-11-10T00:00:00.000Z";

export function failures(report: EngineConformanceReport): string {
	return report.results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}

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
	readonly wrap?: (executor: MongoExecutor) => MongoExecutor;
}

export function memoryHarness(
	options: MemoryHarnessOptions = {},
): EngineHarness {
	return {
		declaredLimits: MONGO_CONFORMANCE_DECLARED_LIMITS,
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
