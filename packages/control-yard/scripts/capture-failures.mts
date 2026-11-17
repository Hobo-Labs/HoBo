import { z } from "zod";

export const captureErrorsSchema = z.array(z.string()).optional();
export const captureChecksSchema = z.array(z.string()).optional();
type ParsedCaptureErrors = ReturnType<typeof captureErrorsSchema.safeParse>;
type ParsedCaptureChecks = ReturnType<typeof captureChecksSchema.safeParse>;

export function captureFailureMessages(
	manifestErrors: ParsedCaptureErrors,
	reportErrors: ParsedCaptureErrors,
	manifestChecks: ParsedCaptureChecks = captureChecksSchema.safeParse(
		undefined,
	),
	reportChecks: ParsedCaptureChecks = captureChecksSchema.safeParse(undefined),
): string[] {
	const failures = new Set<string>();
	for (const [source, value] of [
		["evidence-manifest.json", manifestErrors],
		["visual-report.json", reportErrors],
	] as const) {
		if (!value.success) {
			failures.add(`${source} has an invalid capture errors list`);
			continue;
		}
		for (const entry of value.data ?? []) {
			failures.add(`capture reported failure: ${entry}`);
		}
	}
	for (const [source, value] of [
		["evidence-manifest.json", manifestChecks],
		["visual-report.json", reportChecks],
	] as const) {
		if (!value.success) {
			failures.add(`${source} has an invalid capture checks list`);
			continue;
		}
		for (const entry of value.data ?? []) {
			if (/^FAIL(?:\s|$)/u.test(entry.trimStart())) {
				failures.add(`capture recorded failed check: ${entry}`);
			}
			if (
				/^PASS imgdiff .* — (?:imgdiff skipped|baseline created)/u.test(entry)
			) {
				failures.add(`capture did not compare images: ${entry}`);
			}
		}
	}
	return [...failures];
}
