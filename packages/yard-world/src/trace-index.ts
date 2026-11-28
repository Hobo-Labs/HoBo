import type { SpanKind } from "./model.js";

export const TRACE_INDEX_MAX_ENTRIES = 10_000;
export const TRACE_INDEX_TTL_MS = 15 * 60_000;

export interface IndexedSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | undefined;
	kind: SpanKind;
	characterId: string;
	campId: string;
	startMs: number;
	endMs: number;
	recordedAt: number;
}

function keyFor(traceId: string, spanId: string): string {
	return `${traceId}:${spanId}`;
}

export class TraceIndex {
	private readonly spans = new Map<string, IndexedSpan>();

	constructor(
		private readonly maxEntries = TRACE_INDEX_MAX_ENTRIES,
		private readonly ttlMs = TRACE_INDEX_TTL_MS,
	) {}

	get size(): number {
		return this.spans.size;
	}

	record(entry: Omit<IndexedSpan, "recordedAt">, at: number): void {
		this.evict(at);
		const key = keyFor(entry.traceId, entry.spanId);
		this.spans.delete(key);
		this.spans.set(key, { ...entry, recordedAt: at });
		while (this.spans.size > this.maxEntries) {
			const oldest = this.spans.keys().next().value;
			if (oldest === undefined) break;
			this.spans.delete(oldest);
		}
	}

	lookup(traceId: string, spanId: string, at: number): IndexedSpan | undefined {
		const key = keyFor(traceId, spanId);
		const entry = this.spans.get(key);
		if (entry === undefined) return undefined;
		if (at - entry.recordedAt > this.ttlMs) {
			this.spans.delete(key);
			return undefined;
		}
		return entry;
	}

	private evict(at: number): void {
		for (const [key, entry] of this.spans) {
			if (at - entry.recordedAt > this.ttlMs) this.spans.delete(key);
		}
	}
}
