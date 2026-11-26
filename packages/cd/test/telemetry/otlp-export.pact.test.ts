// PACT for the OTLP/HTTP JSON export boundary owned by WP19. The consumer is
// the real `createTelemetrySink`; each interaction answers the recorded
// response and verifies the request the sink sent (method, path, headers,
// body keys) and the sink's outcome.
import { readFileSync } from "node:fs";
import type { TransportRequest, TransportResponse } from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { OtelMetricPoint, OtelSpan } from "../../src/ports.js";
import { createTelemetrySink } from "../../src/telemetry/index.js";
import { T0 } from "../authz/memory-store.js";

type Interaction = {
	description: string;
	providerState: string;
	request: {
		method: string;
		path: string;
		headers: Record<string, string>;
		bodyKeys: string[];
	};
	response: { status: number; headers?: Record<string, string>; body: unknown };
	outcome: "ok" | "retried" | "otlp-rejected" | "otlp-partial-success";
};

const pact: {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
} = JSON.parse(
	readFileSync(new URL("./otlp-export.pact.json", import.meta.url), "utf8"),
);

const SPAN: OtelSpan = {
	name: "RUN web",
	traceId: "0".repeat(32),
	spanId: "1".repeat(16),
	kind: "server",
	startMs: T0,
	endMs: T0 + 1,
	status: "ok",
	attributes: { "cicd.pipeline.name": "web" },
};

const POINT: OtelMetricPoint = {
	name: "hobo.cd.reconcile.lag",
	kind: "gauge",
	value: 1,
	unit: "s",
	atMs: T0,
	attributes: {},
};

describe(`PACT ${pact.consumer.name} → ${pact.provider.name}`, () => {
	for (const interaction of pact.interactions) {
		it(interaction.description, async () => {
			const seen: TransportRequest[] = [];
			const sleeps: number[] = [];
			const http = async (
				request: TransportRequest,
			): Promise<TransportResponse> => {
				seen.push(request);
				// The throttled interaction answers once, then accepts.
				if (interaction.outcome === "retried" && seen.length > 1)
					return { status: 200, headers: {}, body: "{}" };
				return {
					status: interaction.response.status,
					headers: interaction.response.headers ?? {},
					body: JSON.stringify(interaction.response.body),
				};
			};
			const sink = createTelemetrySink({
				endpoint: "http://collector.test:4318",
				http,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});
			const send =
				interaction.request.path === "/v1/traces"
					? () => sink.spans([SPAN])
					: () => sink.metrics([POINT]);
			if (interaction.outcome === "ok" || interaction.outcome === "retried")
				await send();
			else
				await expect(send()).rejects.toMatchObject({
					code: interaction.outcome,
				});

			const first = seen[0];
			expect(first?.method).toBe(interaction.request.method);
			expect(first?.url).toBe(
				`http://collector.test:4318${interaction.request.path}`,
			);
			for (const [k, v] of Object.entries(interaction.request.headers))
				expect(first?.headers[k]).toBe(v);
			const body = JSON.parse(first?.body ?? "{}");
			for (const key of interaction.request.bodyKeys)
				expect(body[key]).toBeDefined();
			if (interaction.outcome === "retried") {
				expect(seen).toHaveLength(2);
				expect(sleeps).toEqual([2_000]);
			} else expect(seen).toHaveLength(1);
		});
	}
});
