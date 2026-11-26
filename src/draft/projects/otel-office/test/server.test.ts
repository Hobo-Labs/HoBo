import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OfficeServer, createOfficeServer } from "../src/server.js";
import { type JsonValue, type JsonObject } from "../src/json.js";


let office: OfficeServer;
let base: string;

beforeAll(async () => {
	office = createOfficeServer({ simulate: false });
	await new Promise<void>((resolve) => office.server.listen(0, resolve));
	base = `http://localhost:${office.port()}`;
});

afterAll(async () => {
	await office.close();
});

describe("server", () => {
	it("GET / serves the client shell", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("HoBo OTel Office");
	});

	it("GET /state returns the office snapshot", async () => {
		const res = await fetch(`${base}/state`);
		expect(res.status).toBe(200);
		// SAFETY: `const body = (await res.json()) as { characters: JsonObject };` is required at this I/O or test boundary.
		const body = (await res.json()) as { characters: JsonObject };
		expect(body.characters).toBeDefined();
	});

	it("POST /v1/traces ingests OTLP/JSON and updates state", async () => {
		const payload = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "smoke-svc" } },
							{ key: "hobo.camp", value: { stringValue: "camp-smoke" } },
							{ key: "hobo.station", value: { stringValue: "station-smoke" } },
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: "t",
									spanId: "s1",
									name: "GET /",
									kind: 2,
									startTimeUnixNano: "1000000000",
								},
							],
						},
					],
				},
			],
		};
		const res = await fetch(`${base}/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 1 });
		// SAFETY: `const state = (await (await fetch(`${base}/state`)).json()) as {` is required at this I/O or test boundary.
		const state = (await (await fetch(`${base}/state`)).json()) as {
			characters: Record<string, { state: string }>;
		};
		expect(state.characters["station-smoke/smoke-svc"]?.state).toBe("working");
	});

	it("GET /events streams SSE with a snapshot first", async () => {
		const controller = new AbortController();
		const res = await fetch(`${base}/events`, { signal: controller.signal });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body?.getReader();
		const chunk = await reader?.read();
		const text = new TextDecoder().decode(chunk?.value);
		expect(text).toContain("event: snapshot");
		controller.abort();
	});
});

describe("character activity endpoint", () => {
	it("GET /character/<id>/activity returns recent spans for the character", async () => {
		const id = "station-smoke/smoke-svc";
		const res = await fetch(`${base}/character/${encodeURIComponent(id)}/activity`);
		expect(res.status).toBe(200);
		// SAFETY: `const body = (await res.json()) as {` is required at this I/O or test boundary.
		const body = (await res.json()) as {
			character: { id: string; name: string };
			activity: { spans: { name: string; status: string }[]; logs: JsonValue[] };
		};
		expect(body.character.id).toBe(id);
		expect(body.activity.spans.length).toBeGreaterThan(0);
		expect(body.activity.spans[0]?.name).toBe("GET /");
	});

	it("GET /character/<id>/activity 404s for unknown characters", async () => {
		const res = await fetch(`${base}/character/${encodeURIComponent("station-x/nope")}/activity`);
		expect(res.status).toBe(404);
	});
});

describe("logs and metrics intake", () => {
	const resource = [
		{ key: "service.name", value: { stringValue: "smoke-svc" } },
		{ key: "hobo.camp", value: { stringValue: "camp-smoke" } },
		{ key: "hobo.station", value: { stringValue: "station-smoke" } },
	];

	it("POST /v1/logs ingests OTLP/JSON logs; ERROR raises bubble + stuck", async () => {
		const res = await fetch(`${base}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceLogs: [
					{
						resource: { attributes: resource },
						scopeLogs: [
							{
								logRecords: [
									{ severityNumber: 13, severityText: "WARN", body: { stringValue: "lag" } },
									{ severityNumber: 17, severityText: "ERROR", body: { stringValue: "boom" } },
								],
							},
						],
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 2 });
		// SAFETY: `const state = (await (await fetch(`${base}/state`)).json()) as {` is required at this I/O or test boundary.
		const state = (await (await fetch(`${base}/state`)).json()) as {
			characters: Record<string, { bubble?: string; state: string }>;
		};
		expect(state.characters["station-smoke/smoke-svc"]?.bubble).toBe("boom");
		expect(state.characters["station-smoke/smoke-svc"]?.state).toBe("stuck");
		// SAFETY: `const activity = (await (` is required at this I/O or test boundary.
		const activity = (await (
			await fetch(`${base}/character/${encodeURIComponent("station-smoke/smoke-svc")}/activity`)
		).json()) as { activity: { logs: { severity: string }[] } };
		expect(activity.activity.logs).toHaveLength(2);
	});

	it("POST /v1/metrics maps hobo.health onto the health bar, unknown into activity", async () => {
		const res = await fetch(`${base}/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceMetrics: [
					{
						resource: { attributes: resource },
						scopeMetrics: [
							{
								metrics: [
									{ name: "hobo.health", gauge: { dataPoints: [{ asDouble: 0.3 }] } },
									{ name: "queue.depth", gauge: { dataPoints: [{ asInt: 12 }] } },
								],
							},
						],
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 2 });
		// SAFETY: `const state = (await (await fetch(`${base}/state`)).json()) as {` is required at this I/O or test boundary.
		const state = (await (await fetch(`${base}/state`)).json()) as {
			characters: Record<string, { health: number }>;
		};
		expect(state.characters["station-smoke/smoke-svc"]?.health).toBe(0.3);
		// SAFETY: `const activity = (await (` is required at this I/O or test boundary.
		const activity = (await (
			await fetch(`${base}/character/${encodeURIComponent("station-smoke/smoke-svc")}/activity`)
		).json()) as { activity: { metrics: { metric: string; value: number }[] } };
		expect(activity.activity.metrics.map((m) => m.metric)).toContain("queue.depth");
	});
});

describe("cross-request trace pairing over HTTP", () => {
	// Simulator topology (junctions exist) with ticks effectively paused.
	let simOffice: OfficeServer;
	let simBase: string;

	beforeAll(async () => {
		simOffice = createOfficeServer({ simulate: true, seed: 3, tickMs: 3_600_000 });
		await new Promise<void>((resolve) => simOffice.server.listen(0, resolve));
		simBase = `http://localhost:${simOffice.port()}`;
	});

	afterAll(async () => {
		await simOffice.close();
	});

	it("parent posted first, child posted separately → junction packet", async () => {
		const span = (
			service: string,
			camp: string,
			spanId: string,
			kind: number,
			parentSpanId?: string,
		) => ({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: service } },
							{ key: "hobo.station", value: { stringValue: "station-local" } },
							{ key: "hobo.camp", value: { stringValue: camp } },
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: "cross-request-trace",
									spanId,
									...(parentSpanId !== undefined ? { parentSpanId } : undefined),
									name: "POST /orders",
									kind,
									startTimeUnixNano: "1700000000000000000",
								},
							],
						},
					],
				},
			],
		});
		const post = (body: JsonValue) =>
			fetch(`${simBase}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const parentRes = await post(span("api-gateway", "camp-gateway", "parent-x", 3));
		expect(parentRes.status).toBe(200);
		// SAFETY: `let state = (await (await fetch(`${simBase}/state`)).json()) as { packets: unkno` is required at this I/O or test boundary.
		let state = (await (await fetch(`${simBase}/state`)).json()) as { packets: unknown };
		expect(Object.keys(state.packets)).toHaveLength(0);
		const childRes = await post(span("orders-api", "camp-orders", "child-x", 2, "parent-x"));
		expect(childRes.status).toBe(200);
		// SAFETY: `const accepted = (await childRes.json()) as { accepted: number };` is required at this I/O or test boundary.
		const accepted = (await childRes.json()) as { accepted: number };
		expect(accepted.accepted).toBe(2); // span-started + packet-started
		// SAFETY: `state = (await (await fetch(`${simBase}/state`)).json()) as {` is required at this I/O or test boundary.
		state = (await (await fetch(`${simBase}/state`)).json()) as {
			packets: Record<string, { traceId: string; junctionId: string; toCampId: string }>;
		};
		expect(state.packets["child-x"]).toMatchObject({
			traceId: "cross-request-trace",
			junctionId: "jn-gw-orders",
			fromCampId: "camp-gateway",
			toCampId: "camp-orders",
		});
	});
});
