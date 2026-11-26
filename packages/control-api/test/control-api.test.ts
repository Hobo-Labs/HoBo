import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	type ControlApiServer,
	createControlApiServer,
	HOBO_CONTROL_API_PACKAGE,
} from "../src/index.js";

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
	const d = mkdtempSync(join(tmpdir(), "hobo-control-api-"));
	temps.push(d);
	return d;
}

async function json(
	base: string,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: JsonObject }> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...init?.headers,
		},
	});
	return {
		status: res.status,
		// SAFETY: fetch JSON is parsed at this test I/O boundary.
		body: (await res.json()) as JsonObject,
	};
}

describe("@hobo/control-api", () => {
	it("exports package id", () => {
		expect(HOBO_CONTROL_API_PACKAGE).toBe("@hobo/control-api");
	});

	it("serves station init, yard snapshot, connection create/authorize", async () => {
		const home = tempHome();
		const server = await createControlApiServer({ hoboHome: home, port: 0 });
		servers.push(server);

		const health = await json(server.url, "/health");
		expect(health.body.ok).toBe(true);

		const init = await json(server.url, "/v1/station/init", {
			method: "POST",
			body: JSON.stringify({ name: "local", tenant: "local" }),
		});
		expect(init.status).toBe(200);
		expect(init.body.ok).toBe(true);

		const snap = await json(
			server.url,
			"/v1/yard/snapshot?stationId=station:local",
		);
		expect(snap.body.ok).toBe(true);
		// SAFETY: this route's yard snapshot contract contains occupancy and rails.
		const data = snap.body.data as {
			occupancy: { stationId: string; status: string };
			rails: unknown[];
		};
		expect(data.occupancy.stationId).toBe("station:local");
		expect(data.occupancy.status).toBe("open");
		expect(data.rails.length).toBeGreaterThan(0);

		const create = await json(server.url, "/v1/connection/create", {
			method: "POST",
			body: JSON.stringify({
				provider: "asana",
				alias: "work",
				stationId: "station:local",
			}),
		});
		expect(create.body.ok).toBe(true);

		const auth = await json(server.url, "/v1/connection/authorize", {
			method: "POST",
			body: JSON.stringify({ idOrAlias: "work" }),
		});
		expect(auth.body.ok).toBe(true);

		const snap2 = await json(
			server.url,
			"/v1/yard/snapshot?stationId=station:local",
		);
		// SAFETY: this route's yard snapshot contract contains connections and metering.
		const data2 = snap2.body.data as {
			connections: { status: string }[];
			metering: { trafficRate: number };
		};
		expect(data2.connections).toHaveLength(1);
		expect(data2.connections[0]?.status).toBe("active");
		expect(data2.metering.trafficRate).toBeGreaterThan(0);

		const broker = await json(
			server.url,
			"/v1/broker/status?stationId=station:local",
		);
		expect(broker.body.ok).toBe(true);

		const openapi = await json(server.url, "/v1/openapi.json");
		expect(openapi.body.openapi).toBe("3.0.3");
	});

	it("streams yard SSE events", async () => {
		const home = tempHome();
		const server = await createControlApiServer({
			hoboHome: home,
			port: 0,
			streamIntervalMs: 50,
		});
		servers.push(server);
		await json(server.url, "/v1/station/init", {
			method: "POST",
			body: JSON.stringify({ name: "local", tenant: "local" }),
		});

		const ac = new AbortController();
		const res = await fetch(
			`${server.url}/v1/yard/stream?stationId=station:local`,
			{ signal: ac.signal },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
		assert(res.body);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !buf.includes("event: yard")) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
		}
		ac.abort();
		expect(buf).toContain("event: yard");
		expect(buf).toContain("station:local");
	});
});
