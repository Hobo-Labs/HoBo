import type { CdConformanceReport } from "@hobo/conformance";

export function failed<A extends string>(report: CdConformanceReport<A>): readonly string[] {
	return report.failures.map((failure) => failure.assertion).sort();
}

export function summary<A extends string>(report: CdConformanceReport<A>): string {
	return report.failures.map((f) => `${f.assertion}: ${f.detail}`).join("\n");
}
