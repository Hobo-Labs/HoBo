/**
 * How long Vercel lets the relay function (`api/relay.ts`) run, in seconds.
 *
 * `vercel.json` declares the same number as that function's `maxDuration`,
 * and `test/function-limits.test.ts` fails if the two differ, so nothing here
 * can be derived from a limit the platform is not actually told to apply.
 * It is the limit the relay already assumes: the queue consumer waits up to
 * two minutes for this function to finish a worker pass.
 */
export const RELAY_FUNCTION_MAX_DURATION_SECONDS = 300;

/** Kept back from the limit: the function starts, authenticates and answers. */
const WAIT_HEADROOM_SECONDS = 30;
/** Under the 60-second request timeout MCP clients apply by default. */
const WAIT_CEILING_SECONDS = 50;

/**
 * The longest `wait_for_events` may hold a request of this function: inside
 * its duration limit with headroom to spare, and never more than a client
 * will wait for an answer.
 */
export function mcpWaitCeilingMs(functionMaxDurationSeconds: number): number {
	if (
		!Number.isInteger(functionMaxDurationSeconds) ||
		functionMaxDurationSeconds <= WAIT_HEADROOM_SECONDS
	)
		throw new Error("function duration limit leaves no time to wait");
	return (
		Math.min(
			WAIT_CEILING_SECONDS,
			functionMaxDurationSeconds - WAIT_HEADROOM_SECONDS,
		) * 1000
	);
}
