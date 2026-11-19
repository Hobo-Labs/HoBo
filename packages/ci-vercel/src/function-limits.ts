export const RELAY_FUNCTION_MAX_DURATION_SECONDS = 300;

const WAIT_HEADROOM_SECONDS = 30;
const WAIT_CEILING_SECONDS = 50;

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
