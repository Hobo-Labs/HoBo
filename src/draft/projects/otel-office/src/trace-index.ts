/**
 * Server-side trace index (Phase 2 slice 2).
 *
 * A bounded in-memory index of recently ingested spans, keyed by
 * `${traceId}:${spanId}`. A real OTel collector sends each service's spans in
 * separate ExportTraceServiceRequests, so a cross-camp parent/child pair often
 * arrives split across requests. The mapper records every ingested span here
 * and resolves a child's `parentSpanId` against it when the parent is not in
 * the same payload.
 *
 * Bounds (see ADR.md): at most TRACE_INDEX_MAX_ENTRIES entries, and entries
 * older than TRACE_INDEX_TTL_MS are evicted — both enforced lazily on
 * record/lookup, so memory stays flat under continuous ingest.
 */
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
	/** Ingestion-time clock (ms) used for TTL eviction. */
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

	/** Record a span; evicts expired entries and trims to the max size. */
	record(entry: Omit<IndexedSpan, "recordedAt">, at: number): void {
		this.evict(at);
		const key = keyFor(entry.traceId, entry.spanId);
		// Refresh insertion order so re-ingested spans keep their recency.
		this.spans.delete(key);
		this.spans.set(key, { ...entry, recordedAt: at });
		while (this.spans.size > this.maxEntries) {
			const oldest = this.spans.keys().next().value;
			if (oldest === undefined) break;
			this.spans.delete(oldest);
		}
	}

	/** Look up a span by traceId+spanId; expired entries count as absent. */
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
