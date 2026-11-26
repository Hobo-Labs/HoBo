import { appendFileSync } from "node:fs";

/**
 * Append one JSON line of what a real run showed to the file named by
 * HOBO_REAL_EVIDENCE, when it is set, so a run can be saved and attached. Only
 * dummy values are ever in it: the sandbox's token is a dummy by construction
 * and a surrogate is spent when its run ends.
 */
export function record(
	name: string,
	data: Readonly<Record<string, string | number | boolean | readonly string[]>>,
): void {
	const path = process.env.HOBO_REAL_EVIDENCE;
	if (path === undefined || path === "") return;
	appendFileSync(path, `${JSON.stringify({ name, ...data })}\n`);
}
