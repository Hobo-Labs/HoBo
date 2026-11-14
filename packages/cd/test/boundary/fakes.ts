// Test doubles for the boundary suite (owned by WP16; never shared).
import type {
	DurableEventStore,
	EventEnvelope,
	EventPosition,
	HttpTransport,
	PositionedEvent,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import type {
	CredentialResolver,
	OtelMetricPoint,
	TelemetrySink,
} from "../../src/ports.js";

export const SECRET = "whsec_c2VjcmV0LWZvci10ZXN0cy1vbmx5";

export function credentials(
	secret: string | null = SECRET,
): CredentialResolver & {
	readonly calls: Array<{ ref: string; scope: string }>;
} {
	const calls: Array<{ ref: string; scope: string }> = [];
	return {
		calls,
		async resolve(ref, scope) {
			calls.push({ ref, scope });
			return secret === null ? {} : { secret };
		},
	};
}

/** Scripted transport: each call takes the next reply (a response or an error). */
export function scriptedHttp(
	replies: ReadonlyArray<TransportResponse | Error>,
): HttpTransport & { readonly requests: TransportRequest[] } {
	const requests: TransportRequest[] = [];
	let index = 0;
	const transport = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		requests.push(request);
		const reply = replies[Math.min(index, replies.length - 1)];
		index += 1;
		if (reply === undefined) throw new Error("no scripted reply");
		if (reply instanceof Error) throw reply;
		return reply;
	};
	return Object.assign(transport, { requests });
}

export function status(
	code: number,
	headers: Record<string, string> = {},
): TransportResponse {
	return { status: code, headers, body: "" };
}

export function recordingTelemetry(): TelemetrySink & {
	readonly points: OtelMetricPoint[];
} {
	const points: OtelMetricPoint[] = [];
	return {
		points,
		async spans() {},
		async metrics(batch) {
			points.push(...batch);
		},
	};
}

/** A read-only journal: readAll over a fixed list, positions 1..n. */
export function journalStore(
	events: readonly EventEnvelope[],
): Pick<DurableEventStore, "readAll"> {
	const positioned: PositionedEvent[] = events.map((event, i) => ({
		// SAFETY: EventPosition is a branded bigint.
		position: BigInt(i + 1) as EventPosition,
		event,
	}));
	return {
		async *readAll(options?: { after?: EventPosition }) {
			for (const entry of positioned) {
				if (options?.after !== undefined && entry.position <= options.after)
					continue;
				yield entry;
			}
		},
	};
}
