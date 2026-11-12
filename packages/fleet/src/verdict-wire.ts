/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/verdict-wire` (L03): parses the verdict route's JSON for the
 * route job, which runs this file with `node --experimental-strip-types`.
 * It has NO imports (R14), so the not-implemented error is a plain `Error`.
 *
 * Contract commit: the body throws; L03 replaces it.
 */
export function parseFleetVerdict(
	json: string,
	nowMs: number,
):
	| { state: "OPEN" | "NO_MEMBER" | "NO_CAPACITY"; freeSlots: number }
	| undefined {
	throw new Error(
		"parseFleetVerdict is not implemented yet (HoBo Fleet contract commit)",
	);
}
