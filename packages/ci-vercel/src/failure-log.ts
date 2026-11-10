/**
 * One JSON line on stderr for each way the relay refuses a request.
 *
 * Every failure path here answers 503 with a fixed body, and used to do so
 * silently: a relay that could not start looked, in the platform's logs, like
 * a relay nobody was calling. The line names the stage and the error; it
 * never carries a request body, a header or a credential.
 */

/**
 * What a failure is also handed to. Declared here, not imported: this file
 * is bundled into the sandbox proxy, which must not pull in the relay.
 */
export type FailureEvents = Readonly<{
	emit(
		name: string,
		fields: Readonly<Record<string, string | number | boolean>>,
	): void;
	flush(): Promise<void>;
}>;

/** A run of 24 or more token characters: a key, a JWT segment, a digest. */
const SECRET_LIKE = /[A-Za-z0-9+/_=-]{24,}/g;
const URL_USERINFO = /\/\/[^/@\s]+@/g;

const scrub = (text: string) =>
	text
		.replace(URL_USERINFO, "//[redacted]@")
		.replace(SECRET_LIKE, "[redacted]")
		.slice(0, 300);

/** The error's class and message, and its cause's: `fetch failed` alone says nothing. */
export function describeFailure(error: Error | undefined) {
	if (!error) return { error: "unknown", message: "", cause: "" };
	const cause = error.cause instanceof Error ? error.cause : undefined;
	return {
		error: error.name.slice(0, 80),
		message: scrub(error.message),
		cause: cause ? scrub(`${cause.name}: ${cause.message}`) : "",
	};
}

/** Ids and long segments out of a path, so one route is one log key. */
export function failureRoute(path: string | undefined): string {
	return (path ?? "")
		.split("?", 1)
		.join("")
		.split("/")
		.slice(0, 7)
		.map((segment) =>
			!/^v\d+$/.test(segment) && (/\d/.test(segment) || segment.length > 40)
				? "{id}"
				: segment,
		)
		.join("/");
}

export function createFailureLog(options?: {
	write?: (line: string) => void;
	now?: () => number;
	/**
	 * Also emitted as a CloudEvent, for something that reacts and not only
	 * reads. Flushed at once: a function instance may not live to a timer.
	 */
	events?: () => FailureEvents | undefined;
	/** One line per event name in this window; a relay that is down fails every request. */
	minIntervalMs?: number;
}) {
	const write = options?.write ?? ((line: string) => console.error(line));
	const now = options?.now ?? Date.now;
	const minIntervalMs = options?.minIntervalMs ?? 10_000;
	const last = new Map<string, number>();
	const suppressed = new Map<string, number>();
	return function report(
		event: string,
		fields: Readonly<Record<string, string | number | boolean>>,
		/** What was thrown, when it was an Error; anything else is logged as unknown. */
		error: Error | undefined,
	): void {
		// Logging must never change what the caller answers.
		try {
			const previous = last.get(event);
			if (previous !== undefined && now() - previous < minIntervalMs) {
				suppressed.set(event, (suppressed.get(event) ?? 0) + 1);
				return;
			}
			last.set(event, now());
			const body = {
				...fields,
				...describeFailure(error),
				suppressed: suppressed.get(event) ?? 0,
			};
			write(JSON.stringify({ event, ...body }));
			suppressed.delete(event);
			const events = options?.events?.();
			events?.emit(event, body);
			void events?.flush().catch(() => undefined);
		} catch {
			// A failed logger is not a failed request.
		}
	};
}

let relayEvents: FailureEvents | undefined;

/**
 * Where the relay's failures are also delivered as CloudEvents. Set once by
 * the entrypoint, which owns the configuration.
 */
export function setRelayFailureEvents(events: FailureEvents | undefined): void {
	relayEvents = events;
}

/** The process-wide log the relay's entrypoints share. */
export const reportRelayFailure = createFailureLog({
	events: () => relayEvents,
});
