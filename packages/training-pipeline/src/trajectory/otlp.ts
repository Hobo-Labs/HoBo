import { createBoundedFetchTransport, type HttpTransport } from "@hobo/core";
import { z } from "zod";
import {
	type CapturedSpan,
	parseCapturedSpan,
	type SpanExporterPort,
} from "./capture.js";

export interface OtlpSpanExporterOptions {
	readonly endpoint: string;
	readonly resourceAttributes?: Readonly<Record<string, string>>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly maxBatchSize?: number;
	readonly maxBufferedSpans?: number;
	readonly timeoutMs?: number;
	readonly http?: HttpTransport;
}

export interface OtlpSpanExporter extends SpanExporterPort {
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

export class OtlpPartialSuccessError extends Error {
	constructor(
		readonly rejectedSpans: number,
		message: string,
	) {
		super(
			`OTLP collector rejected ${rejectedSpans} span(s)${message ? `: ${message}` : ""}`,
		);
		this.name = "OtlpPartialSuccessError";
	}
}

function positiveInteger(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return result;
}

function attributes(values: Readonly<Record<string, string>>) {
	return Object.entries(values)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, stringValue]) => ({ key, value: { stringValue } }));
}

function encodeSpans(
	spans: readonly CapturedSpan[],
	resource: Readonly<Record<string, string>>,
): string {
	return JSON.stringify({
		resourceSpans: [
			{
				resource: { attributes: attributes(resource) },
				scopeSpans: [
					{
						scope: { name: "@hobo/training-pipeline" },
						spans: spans.map((span) => ({
							traceId: span.traceId,
							spanId: span.spanId,
							parentSpanId: span.parentSpanId || undefined,
							name: span.name,
							kind: 1,
							startTimeUnixNano: (
								BigInt(Date.parse(span.startTime)) * 1_000_000n
							).toString(),
							endTimeUnixNano: (
								BigInt(Date.parse(span.endTime)) * 1_000_000n
							).toString(),
							attributes: attributes(span.attributes),
							status: {
								code: span.status.code === "OK" ? 1 : 2,
								message: span.status.message,
							},
						})),
					},
				],
			},
		],
	});
}

const responseSchema = z.object({
	partialSuccess: z
		.object({
			rejectedSpans: z
				.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
				.default(0),
			errorMessage: z.string().default(""),
		})
		.optional(),
});

function partialSuccess(
	body: string,
	batchSize: number,
): OtlpPartialSuccessError | undefined {
	if (body.trim() === "") return undefined;
	const partial = responseSchema.parse(JSON.parse(body)).partialSuccess;
	if (!partial) return undefined;
	const count = Number(partial.rejectedSpans);
	if (!Number.isSafeInteger(count) || count > batchSize) {
		throw new Error("OTLP rejectedSpans must be a valid batch count");
	}
	return count === 0
		? undefined
		: new OtlpPartialSuccessError(count, partial.errorMessage);
}

export function createOtlpSpanExporter(
	options: OtlpSpanExporterOptions,
): OtlpSpanExporter {
	const endpoint = new URL(options.endpoint);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("OTLP endpoint must use HTTP or HTTPS");
	}
	const maxBatchSize = positiveInteger(
		options.maxBatchSize,
		128,
		"maxBatchSize",
	);
	const maxBufferedSpans = positiveInteger(
		options.maxBufferedSpans,
		2048,
		"maxBufferedSpans",
	);
	const timeoutMs = positiveInteger(options.timeoutMs, 10_000, "timeoutMs");
	if (timeoutMs > 2_147_483_647)
		throw new Error("timeoutMs exceeds supported duration");
	const http =
		options.http ??
		createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	const resource = {
		"service.name": "hobo-training-pipeline",
		...options.resourceAttributes,
	};
	const headers = Object.fromEntries(
		Object.entries(options.headers ?? {}).map(([key, value]) => [
			key.toLowerCase(),
			value,
		]),
	);
	headers["content-type"] = "application/json";
	let pending: CapturedSpan[] = [];
	let inFlightCount = 0;
	let active: Promise<void> | undefined;
	let closed = false;

	async function send(batch: CapturedSpan[]): Promise<void> {
		inFlightCount = batch.length;
		let accepted = false;
		try {
			const response = await http({
				method: "POST",
				url: endpoint.toString(),
				headers,
				body: encodeSpans(batch, resource),
				timeoutMs,
				maxResponseBytes: 1_048_576,
			});
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`OTLP collector returned HTTP ${response.status}`);
			}
			const partial = partialSuccess(response.body, batch.length);
			accepted = true;
			if (partial) throw partial;
		} catch (error) {
			if (!accepted) pending = batch.concat(pending);
			throw error;
		} finally {
			inFlightCount = 0;
		}
	}

	async function flush(): Promise<void> {
		while (active || pending.length > 0) {
			if (active) {
				await active;
				continue;
			}
			const work = send(pending.splice(0, maxBatchSize));
			active = work;
			try {
				await work;
			} finally {
				if (active === work) active = undefined;
			}
		}
	}

	return {
		export(span) {
			if (closed) throw new Error("OTLP exporter is shut down");
			if (pending.length + inFlightCount >= maxBufferedSpans) {
				throw new Error("OTLP exporter buffer is full");
			}
			pending.push(parseCapturedSpan(span));
		},
		flush,
		async shutdown() {
			closed = true;
			await flush();
		},
	};
}
