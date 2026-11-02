import type { Pool } from "pg";

const CONNECTION_STRING =
	/(postgres(?:ql)?|mysql|redis):\/\/[^\s"'`]+/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;

/** Strip connection strings and bearer tokens from pool error text before logging. */
export function redactPoolErrorMessage(message: string): string {
	return message
		.replace(CONNECTION_STRING, "[redacted-connection-string]")
		.replace(BEARER, "Bearer [redacted]");
}

export function formatPoolErrorLog(cause: Error): string {
	const message = redactPoolErrorMessage(cause.message);
	return JSON.stringify({
		event: "hobo_ci_isolated_worker_pool_error",
		message,
	});
}

function poolErrorCause(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Neon/serverless pools emit `error` on idle clients; without a listener Node exits.
 * Log and continue so the poll loop can reconnect on the next tick.
 */
export function attachPostgresPoolErrorHandler(
	pool: Pick<Pool, "on">,
	log: (line: string) => void = (line) => console.error(line),
): void {
	pool.on("error", (cause) => {
		log(formatPoolErrorLog(poolErrorCause(cause)));
	});
}
