import { z } from "zod";

/** Check recorded capture failures; older evidence may omit the field. */
export const captureErrorsSchema = z.array(z.string()).optional();
type ParsedCaptureErrors = ReturnType<typeof captureErrorsSchema.safeParse>;

export function captureFailureMessages(
	manifestErrors: ParsedCaptureErrors,
	reportErrors: ParsedCaptureErrors,
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
	return [...failures];
}
