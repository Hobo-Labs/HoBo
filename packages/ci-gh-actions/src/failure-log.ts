export type FailureEvents = Readonly<{
	emit(
		name: string,
		fields: Readonly<Record<string, string | number | boolean>>,
	): void;
	flush(): Promise<void>;
}>;

const SECRET_LIKE = /[A-Za-z0-9+/_=-]{24,}/g;
const URL_USERINFO = /\/\/[^/@\s]+@/g;

const scrub = (text: string) =>
	text
		.replace(URL_USERINFO, "//[redacted]@")
		.replace(SECRET_LIKE, "[redacted]")
		.slice(0, 300);

const SQLSTATE = /^[0-9A-Z]{5}$/;

function sqlstateOf(error: Error | undefined): string {
	if (!error || !("code" in error)) return "";
	const code = String(error.code);
	return SQLSTATE.test(code) ? code : "";
}

export function describeFailure(error: Error | undefined) {
	if (!error) return { error: "unknown", message: "", cause: "" };
	const cause = error.cause instanceof Error ? error.cause : undefined;
	const described = {
		error: error.name.slice(0, 80),
		message: scrub(error.message),
		cause: cause ? scrub(`${cause.name}: ${cause.message}`) : "",
	};
	const sqlstate = sqlstateOf(cause) || sqlstateOf(error);
	return sqlstate ? { ...described, sqlstate } : described;
}

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
	events?: () => FailureEvents | undefined;
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
		error: Error | undefined,
	): void {
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
		} catch {}
	};
}

let relayEvents: FailureEvents | undefined;

export function setRelayFailureEvents(events: FailureEvents | undefined): void {
	relayEvents = events;
}

export const reportRelayFailure = createFailureLog({
	events: () => relayEvents,
});
