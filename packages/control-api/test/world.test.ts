import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type ControlApiServer, createControlApiServer } from "../src/index.js";

const temps: string[] = [];
const servers: ControlApiServer[] = [];
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-control-api-world-"));
	temps.push(d);
	return d;
}

async function boot(
	opts: Partial<Parameters<typeof createControlApiServer>[0]> = {},
): Promise<ControlApiServer> {
	const server = await createControlApiServer({
		hoboHome: tempHome(),
		port: 0,
		...opts,
	});
	servers.push(server);
	return server;
}

async function json(
	base: string,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: JsonObject }> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
	return {
		status: res.status,
		// SAFETY: fetch JSON is parsed at this test I/O boundary.
		body: (await res.json()) as JsonObject,
	};
}

/** Minimal ExportTraceServiceRequest (mirrors the yard-world mapper fixture). */
function traceFixture() {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "orders-api" } },
						{ key: "hobo.station", value: { stringValue: "station-a" } },
						{ key: "hobo.yard", value: { stringValue: "yard-1" } },
						{ key: "hobo.camp", value: { stringValue: "camp-orders" } },
					],
				},
				scopeSpans: [
					{
						spans: [
							{
								traceId: "abc",
								spanId: "sp-1",
								name: "op",
								kind: 2,
								startTimeUnixNano: "1000000000",
								endTimeUnixNano: "1500000000",
								status: { code: 1 },
							},
						],
					},
				],
			},
		],
	};
}

type WorldEnvelope = {
	world: {
		tick: number;
		characters: Record<string, { name: string; state: string }>;
	};
	demo: boolean;
	seed: number | null;
};

describe("@hobo/control-api world read model", () => {
	it("returns an ok envelope for an empty world with demo off", async () => {
		const server = await boot();
		const snap = await json(server.url, "/v1/world/snapshot");
		expect(snap.status).toBe(200);
		expect(snap.body.ok).toBe(true);
		// SAFETY: the world snapshot endpoint returns the declared WorldEnvelope.
		const data = snap.body.data as WorldEnvelope;
		expect(data.demo).toBe(false);
		expect(data.seed).toBeNull();
		expect(data.world.tick).toBe(0);
		expect(Object.keys(data.world.characters)).toHaveLength(0);
	});

	it("demo mode produces a deterministic non-empty world for a fixed seed", async () => {
		const a = await boot({ demo: true, demoSeed: 7, demoIntervalMs: 0 });
		const b = await boot({ demo: true, demoSeed: 7, demoIntervalMs: 0 });
		expect(a.demo).toBe(true);
		expect(a.demoSeed).toBe(7);
		for (let i = 0; i < 5; i += 1) {
			expect(a.tickDemo()).toBe(b.tickDemo());
		}
		const snapA = await json(a.url, "/v1/world/snapshot");
		const snapB = await json(b.url, "/v1/world/snapshot");
		// SAFETY: the world snapshot endpoint returns the declared WorldEnvelope.
		const dataA = snapA.body.data as WorldEnvelope;
		// SAFETY: the world snapshot endpoint returns the declared WorldEnvelope.
		const dataB = snapB.body.data as WorldEnvelope;
		expect(dataA.demo).toBe(true);
		expect(dataA.seed).toBe(7);
		expect(dataA.world.tick).toBe(5);
		expect(Object.keys(dataA.world.characters).length).toBeGreaterThanOrEqual(
			10,
		);
		// Same seed → identical world content.
		expect(dataA.world).toEqual(dataB.world);
	});

	it("OTLP trace POST materializes a character in the world", async () => {
		const server = await boot();
		const ingest = await json(server.url, "/v1/otlp/v1/traces", {
			method: "POST",
			body: JSON.stringify(traceFixture()),
		});
		expect(ingest.status).toBe(200);
		expect(ingest.body.ok).toBe(true);
		// SAFETY: the ingest response contract contains an accepted count.
		const accepted = (ingest.body.data as { accepted: number }).accepted;
		expect(accepted).toBeGreaterThanOrEqual(2); // span-started + span-ended

		const snap = await json(server.url, "/v1/world/snapshot");
		// SAFETY: the world snapshot endpoint returns the declared WorldEnvelope.
		const data = snap.body.data as WorldEnvelope;
		expect(data.world.characters["station-a/orders-api"]?.name).toBe(
			"orders-api",
		);
	});

	it("malformed OTLP JSON yields a 400 envelope", async () => {
		const server = await boot();
		const res = await json(server.url, "/v1/otlp/v1/logs", {
			method: "POST",
			body: "{not json",
		});
		expect(res.status).toBe(400);
		expect(res.body.ok).toBe(false);
		expect(res.body.code).toBe("bad-request");
	});

	it("world SSE emits world-snapshot on connect, then world deltas per tick", async () => {
		const server = await boot({
			demo: true,
			demoSeed: 42,
			demoIntervalMs: 0,
			streamIntervalMs: 50,
		});
		const ac = new AbortController();
		const res = await fetch(`${server.url}/v1/world/stream`, {
			signal: ac.signal,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
		assert(res.body);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const readUntil = async (marker: string): Promise<void> => {
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline && !buf.includes(marker)) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
			}
		};
		await readUntil("event: world-snapshot");
		expect(buf).toContain("event: world-snapshot");
		expect(buf).toContain('"demo":true');
		expect(buf).toContain('"seed":42');

		server.tickDemo();
		await readUntil("event: world\ndata:");
		ac.abort();
		const delta = buf.split("event: world\n")[1];
		expect(delta).toBeDefined();
		expect(delta).toContain('"tick":1');
		expect(delta).toContain('"events":[');
	});
});

describe("OTLP ingest is not a cross-origin write primitive", () => {
	// Ingest materializes stations, camps and characters that render as real,
	// unbadged telemetry. A browser can POST cross-origin without preflight when
	// the content type is "simple", so these guards are load-bearing.
	it("refuses a browser Origin", async () => {
		const server = await createControlApiServer({
			hoboHome: tempHome(),
			port: 0,
			host: "127.0.0.1",
		});
		try {
			const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example",
				},
				body: JSON.stringify({ resourceSpans: [] }),
			});
			expect(res.status).toBe(403);
			expect((await res.json()).code).toBe("cross-origin-write-refused");
		} finally {
			await server.close();
		}
	});

	it("refuses a non-JSON content type (the no-preflight path)", async () => {
		const server = await createControlApiServer({
			hoboHome: tempHome(),
			port: 0,
			host: "127.0.0.1",
		});
		try {
			const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({ resourceSpans: [] }),
			});
			expect(res.status).toBe(415);
		} finally {
			await server.close();
		}
	});

	it("rejects an unmappable payload instead of 500-ing the batch", async () => {
		const server = await createControlApiServer({
			hoboHome: tempHome(),
			port: 0,
			host: "127.0.0.1",
		});
		try {
			const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ resourceSpans: [null] }),
			});
			expect(res.status).toBeLessThan(500);
		} finally {
			await server.close();
		}
	});
});
