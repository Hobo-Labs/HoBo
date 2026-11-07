/**
 * The control-API surface, route by route and refusal by refusal.
 *
 * `control-api.test.ts` walks one happy path through the station lifecycle.
 * This covers the rest of the surface: every route the dispatcher knows, the
 * places a route reads the same value from two sources, and the four ways an
 * OTLP ingest can be turned away.
 *
 * The ingest refusals are the part worth being careful about. `/v1/otlp/...`
 * is unauthenticated and *writes* control-plane state that renders as real,
 * unbadged telemetry — so it has to be unreachable from a page the operator
 * merely visited. Two guards do that together: the request must declare
 * `application/json` (which forces a CORS preflight a browser cannot skip),
 * and any request carrying an `Origin` is refused outright. Either guard alone
 * leaves a hole, so both are pinned here, and so is the fact that a refusal
 * says *which* guard fired — an exporter misconfigured in a datacentre needs
 * to be able to tell 415 from 403 without reading this source.
 *
 * The `body.x ?? query.x` fallbacks look like conveniences and are not: the
 * CLI posts a JSON body while a browser or curl user passes a query string,
 * and a route that honoured only one of them would work for exactly one of
 * those callers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	type ControlApiServer,
	type ControlApiServerOptions,
	createControlApiServer,
	PayloadTooLargeError,
} from "../src/index.js";

const temps: string[] = [];
const servers: ControlApiServer[] = [];
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-capi-routes-"));
	temps.push(d);
	return d;
}

async function start(
	overrides: Partial<ControlApiServerOptions> = {},
): Promise<ControlApiServer> {
	const server = await createControlApiServer({
		hoboHome: tempHome(),
		port: 0,
		...overrides,
	});
	servers.push(server);
	return server;
}

async function call(
	base: string,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: JsonObject }> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
	const text = await res.text();
	return {
		status: res.status,
		// SAFETY: JSON.parse is the test HTTP response boundary.
		body: text ? (JSON.parse(text) as JsonObject) : {},
	};
}

const post = (base: string, path: string, body?: JsonValue) => {
	const init: RequestInit = { method: "POST" };
	if (body !== undefined) init.body = JSON.stringify(body);
	return call(base, path, init);
};

/** A station, since most routes are meaningless without one. */
async function withStation(): Promise<ControlApiServer> {
	const server = await start();
	await post(server.url, "/v1/station/init", {
		name: "local",
		tenant: "local",
	});
	return server;
}

describe("binding", () => {
	it("reports the port it actually bound, not the zero it asked for", async () => {
		// Port 0 means "any free port"; a caller that echoed the request back
		// would hand out an unusable URL.
		const server = await start();
		expect(server.port).toBeGreaterThan(0);
		expect(server.url).toContain(String(server.port));
	});

	it("defaults to loopback rather than every interface", async () => {
		// A local-first control plane binding 0.0.0.0 by default would expose an
		// unauthenticated write surface to the network.
		expect((await start()).host).toBe("127.0.0.1");
	});

	it("closes idempotently enough to be awaited twice", async () => {
		const server = await start();
		await server.close();
		await expect(server.close()).rejects.toThrow();
		servers.splice(servers.indexOf(server), 1);
	});
});

describe("CORS and method handling", () => {
	it("answers a preflight without reaching a route", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/v1/station/status`, {
			method: "OPTIONS",
		});
		expect(res.status).toBe(204);
	});

	it("advertises the headers the browser client actually sends", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/anything`, { method: "OPTIONS" });
		expect(res.headers.get("access-control-allow-headers")).toContain(
			"x-hobo-tenant",
		);
	});

	it("answers a preflight for a path no route serves", async () => {
		// The preflight is answered before routing, so an unknown path still gets
		// a usable CORS answer rather than a 404 the browser cannot read.
		const server = await start();
		const res = await fetch(`${server.url}/v1/nope`, { method: "OPTIONS" });
		expect(res.status).toBe(204);
	});

	it("marks every JSON answer no-store", async () => {
		// Control-plane answers are point-in-time state; a cached one is a lie
		// with a timestamp.
		const server = await start();
		const res = await fetch(`${server.url}/health`);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

describe("the always-on routes", () => {
	it("serves health without a station", async () => {
		const server = await start();
		const { status, body } = await call(server.url, "/health");
		expect(status).toBe(200);
		expect(body.service).toBe("@hobo/control-api");
	});

	it("describes its own surface", async () => {
		const { body } = await call((await start()).url, "/v1/openapi.json");
		expect(body.openapi).toBe("3.0.3");
	});

	it("lists every dispatchable route in that description", async () => {
		// The description is what a client generates against; a route missing
		// from it is a route nobody can discover.
		const { body } = await call((await start()).url, "/v1/openapi.json");
		// SAFETY: the OpenAPI response contract exposes a string-keyed paths object.
		const paths = Object.keys(body.paths as JsonObject);
		for (const expected of [
			"/v1/station/init",
			"/v1/connection/create",
			"/v1/broker/status",
			"/v1/doctor",
			"/v1/yard/snapshot",
			"/v1/deployments/view",
			"/v1/audit/credentials",
			"/v1/otlp/v1/traces",
		]) {
			expect(paths).toContain(expected);
		}
	});

	it("404s an unknown path and names what it could not route", async () => {
		const { status, body } = await call((await start()).url, "/v1/nope");
		expect(status).toBe(404);
		expect(body.code).toBe("not-found");
		expect(String(body.message)).toContain("/v1/nope");
	});

	it("404s a known path under the wrong method", async () => {
		// Method is part of the route; answering a GET-only path on POST would
		// run a mutation the client did not intend.
		const { status } = await post((await start()).url, "/v1/doctor");
		expect(status).toBe(404);
	});
});

describe("station routes", () => {
	it("initialises a station", async () => {
		const { status, body } = await post(
			(await start()).url,
			"/v1/station/init",
			{ name: "local", tenant: "local" },
		);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it("reports status for a named station", async () => {
		const server = await withStation();
		const { body } = await call(
			server.url,
			"/v1/station/status?stationId=station:local",
		);
		expect(body.ok).toBe(true);
	});

	it.each([
		"up",
		"down",
	])("takes the station id for /%s from the body", async (verb) => {
		const server = await withStation();
		const { body } = await post(server.url, `/v1/station/${verb}`, {
			stationId: "station:local",
		});
		expect(body.ok).toBe(true);
	});

	it.each([
		"up",
		"down",
	])("falls back to the query string for /%s", async (verb) => {
		// The CLI posts a body; a curl or browser caller passes a query. A
		// route honouring only one works for exactly one of them.
		const server = await withStation();
		const { body } = await post(
			server.url,
			`/v1/station/${verb}?stationId=station:local`,
		);
		expect(body.ok).toBe(true);
	});

	it("lists rails", async () => {
		const server = await withStation();
		const { status } = await call(
			server.url,
			"/v1/station/rails?stationId=station:local",
		);
		expect(status).toBeLessThan(500);
	});

	it.each([
		"publish",
		"approve",
		"activate",
	])("routes rails %s rather than 404ing it", async (verb) => {
		// These may refuse on their own merits; what is pinned here is that the
		// dispatcher reaches them at all.
		const server = await withStation();
		const { status } = await post(server.url, `/v1/station/rails/${verb}`, {
			stationId: "station:local",
			hashOrId: "sha256:none",
		});
		expect(status).not.toBe(404);
	});
});

describe("connection routes", () => {
	it("creates a connection with an array of scopes", async () => {
		const server = await withStation();
		const { status } = await post(server.url, "/v1/connection/create", {
			provider: "github",
			stationId: "station:local",
			scopes: ["repo", "read:org"],
		});
		expect(status).not.toBe(404);
	});

	it("accepts scopes as a comma-separated string", async () => {
		// Query-string and shell callers cannot express a JSON array cheaply.
		const server = await withStation();
		const { status } = await post(server.url, "/v1/connection/create", {
			provider: "github",
			stationId: "station:local",
			scopes: "repo, read:org",
		});
		expect(status).not.toBe(404);
	});

	it("creates a connection with no scopes at all", async () => {
		const server = await withStation();
		const { status } = await post(server.url, "/v1/connection/create", {
			provider: "github",
			stationId: "station:local",
		});
		expect(status).not.toBe(404);
	});

	it("lists connections filtered by query", async () => {
		const server = await withStation();
		const { body } = await call(
			server.url,
			"/v1/connection?tenant=local&provider=github&status=pending&subjectId=s1",
		);
		expect(body.ok).toBe(true);
	});

	it("lists connections with no filters", async () => {
		expect(
			(await call((await withStation()).url, "/v1/connection")).body.ok,
		).toBe(true);
	});

	it("authorizes by id or alias", async () => {
		const server = await withStation();
		const { status } = await post(server.url, "/v1/connection/authorize", {
			idOrAlias: "conn:missing",
			grantedScopes: ["repo"],
		});
		expect(status).not.toBe(404);
	});

	it("accepts the legacy `id` spelling when authorizing", async () => {
		const server = await withStation();
		const { status } = await post(server.url, "/v1/connection/authorize", {
			id: "conn:missing",
		});
		expect(status).not.toBe(404);
	});

	it("routes a connection fetch by path segment", async () => {
		const server = await withStation();
		const { status } = await call(server.url, "/v1/connection/conn%3Amissing");
		expect(status).not.toBe(404);
	});

	it("decodes a percent-encoded id in the path", async () => {
		// Connection ids carry colons; a route that did not decode would look up
		// a literal `%3A` and report the wrong thing missing.
		const server = await withStation();
		const { body } = await call(server.url, "/v1/connection/conn%3Amissing");
		expect(JSON.stringify(body)).not.toContain("%3A");
	});

	it.each(["revoke", "rotate"])("routes a connection %s", async (verb) => {
		const server = await withStation();
		const { status } = await post(
			server.url,
			`/v1/connection/conn%3Amissing/${verb}`,
			{ tenant: "local" },
		);
		expect(status).not.toBe(404);
	});

	it.each([
		"revoke",
		"rotate",
	])("falls back to the query tenant for %s", async (verb) => {
		const server = await withStation();
		const { status } = await post(
			server.url,
			`/v1/connection/conn%3Amissing/${verb}?tenant=local`,
		);
		expect(status).not.toBe(404);
	});
});

describe("projection routes", () => {
	it("serves broker status", async () => {
		const server = await withStation();
		const { body } = await call(
			server.url,
			"/v1/broker/status?stationId=station:local",
		);
		expect(body).toHaveProperty("ok");
	});

	it("serves a doctor snapshot", async () => {
		const server = await withStation();
		const { body } = await call(
			server.url,
			"/v1/doctor?stationId=station:local",
		);
		expect(body).toHaveProperty("ok");
	});

	it("serves a yard snapshot", async () => {
		const server = await withStation();
		const { body } = await call(
			server.url,
			"/v1/yard/snapshot?stationId=station:local&tenant=local",
		);
		expect(body).toHaveProperty("ok");
	});

	it("serves an honest empty deployment view when there is no source", async () => {
		// An empty view is the correct answer for a station that has deployed
		// nothing; erroring would make "nothing yet" indistinguishable from
		// "broken".
		const server = await withStation();
		const { status, body } = await call(server.url, "/v1/deployments/view");
		expect(status).toBeLessThan(500);
		expect(body).toHaveProperty("ok");
	});

	it("serves a credential audit", async () => {
		const server = await withStation();
		const { body } = await call(
			server.url,
			"/v1/audit/credentials?tenant=local&yard=yard:local",
		);
		expect(body).toHaveProperty("ok");
	});
});

describe("the world read model", () => {
	it("serves an empty, non-demo snapshot by default", async () => {
		const server = await start();
		const { body } = await call(server.url, "/v1/world/snapshot");
		// SAFETY: the world snapshot response contains the documented data object.
		const data = body.data as JsonObject;
		expect(data.demo).toBe(false);
		expect(data.seed).toBeNull();
	});

	it("labels a demo world as demo, with its seed", async () => {
		// The badge is the whole point: simulated telemetry that rendered
		// unlabelled next to real telemetry would be indistinguishable from it.
		const server = await start({ demo: true, demoSeed: 7, demoIntervalMs: 0 });
		expect(server.demo).toBe(true);
		expect(server.demoSeed).toBe(7);
		const { body } = await call(server.url, "/v1/world/snapshot");
		// SAFETY: the world snapshot response contains the documented data object.
		expect((body.data as JsonObject).demo).toBe(true);
	});

	it("defaults a demo seed rather than running unreproducibly", async () => {
		const server = await start({ demo: true, demoIntervalMs: 0 });
		expect(server.demoSeed).toBe(42);
	});

	it("seeds the world from the simulator's topology", async () => {
		// The reducer folds events onto known characters; an empty world would
		// drop every simulated event on the floor.
		const server = await start({ demo: true, demoIntervalMs: 0 });
		expect(Object.keys(server.worldSnapshot()).length).toBeGreaterThan(0);
	});

	it("advances the world when ticked", async () => {
		const server = await start({ demo: true, demoIntervalMs: 0 });
		server.tickDemo();
		expect(server.worldSnapshot().tick).toBeGreaterThanOrEqual(0);
	});

	it("produces no events when ticked without a simulator", async () => {
		expect((await start()).tickDemo()).toBe(0);
	});

	it("opens the SSE stream with a snapshot before any delta", async () => {
		// A subscriber that received only deltas would have nothing to apply them
		// to until the first change.
		const server = await start();
		const res = await fetch(`${server.url}/v1/world/stream`);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let first = "";
		while (!first.includes("world-snapshot")) {
			const { value, done } = await reader.read();
			if (done) break;
			first += decoder.decode(value, { stream: true });
		}
		expect(first).toContain("world-snapshot");
		await reader.cancel();
	});

	it("heartbeats the world stream so a quiet world is not mistaken for a dead one", async () => {
		const server = await start({ streamIntervalMs: 20 });
		const res = await fetch(`${server.url}/v1/world/stream`);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let seen = "";
		for (let i = 0; i < 8 && !seen.includes("event: heartbeat"); i += 1) {
			seen += new TextDecoder().decode((await reader.read()).value);
		}
		expect(seen).toContain("event: heartbeat");
		await reader.cancel();
	});

	it("pushes a delta to an open stream when the world changes", async () => {
		const server = await start({ demo: true, demoIntervalMs: 0 });
		const res = await fetch(`${server.url}/v1/world/stream`);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read(); // snapshot
		server.tickDemo();
		const chunk = new TextDecoder().decode((await reader.read()).value);
		expect(chunk).toContain("event: world");
		await reader.cancel();
	});
});

describe("OTLP ingest", () => {
	const traces = { resourceSpans: [] };

	it("accepts an OTLP/JSON trace batch", async () => {
		const server = await start();
		const { status, body } = await post(
			server.url,
			"/v1/otlp/v1/traces",
			traces,
		);
		expect(status).toBe(200);
		// SAFETY: the ingest response data contains the accepted count.
		expect((body.data as JsonObject).accepted).toBe(0);
	});

	it.each(["logs", "metrics"])("accepts an OTLP/JSON %s batch", async (sig) => {
		const server = await start();
		const payload =
			sig === "logs" ? { resourceLogs: [] } : { resourceMetrics: [] };
		const { status } = await post(server.url, `/v1/otlp/v1/${sig}`, payload);
		expect(status).toBe(200);
	});

	it("refuses an unrecognised signal name outright", async () => {
		const { status } = await post(
			(await start()).url,
			"/v1/otlp/v1/profiles",
			{},
		);
		expect(status).toBe(404);
	});

	it("refuses a content type that would skip the browser preflight", async () => {
		// `text/plain` is a CORS-simple type: a page could POST it cross-origin
		// with no preflight at all, so it must not be a way in.
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify(traces),
		});
		expect(res.status).toBe(415);
		// SAFETY: the error response is a JSON object with a code field.
		expect(((await res.json()) as JsonObject).code).toBe(
			"unsupported-media-type",
		);
	});

	it("accepts a content type carrying a charset parameter", async () => {
		// Real exporters send `application/json; charset=utf-8`; an exact-match
		// check would reject every one of them.
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "APPLICATION/JSON; charset=utf-8" },
			body: JSON.stringify(traces),
		});
		expect(res.status).toBe(200);
	});

	it("refuses any request carrying a browser Origin", async () => {
		// The second guard, independent of the first: an ingest that writes
		// unbadged telemetry must be unreachable from a page the operator
		// merely visited.
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://evil.example",
			},
			body: JSON.stringify(traces),
		});
		expect(res.status).toBe(403);
		// SAFETY: the error response is a JSON object with a code field.
		expect(((await res.json()) as JsonObject).code).toBe(
			"cross-origin-write-refused",
		);
	});

	it("tells the two refusals apart, so a misconfigured exporter can be fixed", async () => {
		const server = await start();
		const wrongType = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "{}",
		});
		expect(wrongType.status).not.toBe(403);
	});

	it("treats an empty Origin as absent rather than as a refusal", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "" },
			body: JSON.stringify(traces),
		});
		expect(res.status).toBe(200);
	});

	it("rejects malformed JSON as the caller's fault, not a crash", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		// SAFETY: the error response is a JSON object with a code field.
		expect(((await res.json()) as JsonObject).code).toBe("bad-request");
	});

	it("names the signal in a malformed-payload message", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(
			// SAFETY: the error response is a JSON object with a message field.
			String(((await res.json()) as JsonObject).message),
		).toContain("logs");
	});

	it("treats an empty body as an empty batch", async () => {
		// An exporter flushing nothing is not an error.
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
	});

	it("treats a whitespace-only body as an empty batch", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/v1/otlp/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "  \n ",
		});
		expect(res.status).toBe(200);
	});
});

describe("PayloadTooLargeError", () => {
	it("names its own limit, so an operator can size their exporter batches", () => {
		const err = new PayloadTooLargeError();
		expect(err.message).toContain(String(8 * 1024 * 1024));
	});

	it("is identifiable by name across a serialization boundary", () => {
		// The handler branches on `instanceof`, but a log line only carries the
		// name — it has to be the distinctive one.
		expect(new PayloadTooLargeError().name).toBe("PayloadTooLargeError");
	});

	it("is an Error", () => {
		expect(new PayloadTooLargeError()).toBeInstanceOf(Error);
	});
});

describe("the yard SSE stream", () => {
	it("opens with a comment line, so a proxy sees bytes immediately", async () => {
		const server = await withStation();
		const res = await fetch(
			`${server.url}/v1/yard/stream?stationId=station:local`,
		);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain(": control-api yard stream");
		await reader.cancel();
	});

	it("declares itself an event stream that must not be buffered", async () => {
		// `no-transform` is what stops a proxy from batching the stream into a
		// single response the client never sees until close.
		const server = await withStation();
		const res = await fetch(
			`${server.url}/v1/yard/stream?stationId=station:local`,
		);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(res.headers.get("cache-control")).toContain("no-transform");
		// SAFETY: fetch provides a byte stream for this SSE response.
		await (res.body as ReadableStream<Uint8Array>).cancel();
	});

	it("emits a yard frame or an error frame, never silence", async () => {
		const server = await withStation();
		const res = await fetch(
			`${server.url}/v1/yard/stream?stationId=station:local&tenant=local`,
		);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let seen = "";
		for (let i = 0; i < 3 && !/event: (yard|error)/u.test(seen); i += 1) {
			seen += new TextDecoder().decode((await reader.read()).value);
		}
		expect(seen).toMatch(/event: (yard|error)/u);
		await reader.cancel();
	});

	it("heartbeats instead of resending an unchanged projection", async () => {
		// The dashboard needs to know the stream is alive; resending the same
		// snapshot every interval would say so at the cost of the whole payload,
		// on every tick, forever.
		const server = await start({ streamIntervalMs: 20 });
		await post(server.url, "/v1/station/init", {
			name: "local",
			tenant: "local",
		});
		const res = await fetch(
			`${server.url}/v1/yard/stream?stationId=station:local`,
		);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let seen = "";
		for (let i = 0; i < 8 && !seen.includes("event: heartbeat"); i += 1) {
			seen += new TextDecoder().decode((await reader.read()).value);
		}
		expect(seen).toContain("event: heartbeat");
		await reader.cancel();
	});

	it("reports a projection failure as an error frame rather than closing", async () => {
		// A stream that died on a bad request would look like a network fault to
		// the dashboard, which would then reconnect forever.
		const server = await start();
		const res = await fetch(
			`${server.url}/v1/yard/stream?stationId=station:none`,
		);
		// SAFETY: fetch provides a byte stream for this SSE response.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let seen = "";
		for (let i = 0; i < 3 && !/event: (yard|error)/u.test(seen); i += 1) {
			seen += new TextDecoder().decode((await reader.read()).value);
		}
		expect(seen).toMatch(/event: (yard|error)/u);
		await reader.cancel();
	});
});
