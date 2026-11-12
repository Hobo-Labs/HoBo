/**
 * The `/v1/cd/` mount (plan 0024 WP12). The control API stays free of a
 * build-time dependency on `@hobo/cd`: it mounts any handler with the
 * delivery-feed shape (`pathPrefix`, `handle(request, signal)`), which
 * `createCdControlApi` from `@hobo/cd/service` satisfies. These tests pin the
 * HTTP adaptation: method, path+query, lower-cased headers and raw body go in
 * unchanged; status, headers and JSON or streamed bodies come out unchanged; a
 * client disconnect aborts the handler; the CD OpenAPI paths are merged into
 * `/v1/openapi.json`; and without a mount `/v1/cd/` is a plain 404.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	type CdHttpMount,
	type CdHttpRequest,
	type CdHttpResponse,
	type ControlApiServer,
	createControlApiServer,
} from "../src/index.js";

const temps: string[] = [];
const servers: ControlApiServer[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(cd?: CdHttpMount): Promise<ControlApiServer> {
	const hoboHome = mkdtempSync(join(tmpdir(), "hobo-capi-cd-"));
	temps.push(hoboHome);
	const server = await createControlApiServer({ hoboHome, port: 0, ...(cd ? { cd } : {}) });
	servers.push(server);
	return server;
}

const encoder = new TextEncoder();

function recordingMount(respond: (req: CdHttpRequest, signal: AbortSignal) => Promise<CdHttpResponse>) {
	const seen: CdHttpRequest[] = [];
	const mount: CdHttpMount = {
		pathPrefix: "/v1/cd/",
		async handle(req, signal) {
			seen.push(req);
			return respond(req, signal);
		},
		openapi: () => ({
			openapi: "3.1.0",
			paths: { "/v1/cd/camps": { get: { summary: "Camp inventory" } } },
			components: { schemas: { CampList: { type: "object" } } },
		}),
	};
	return { mount, seen };
}

describe("control-api /v1/cd/ mount", () => {
	it("passes method, path with query, headers and raw body through; returns status, headers and body", async () => {
		const { mount, seen } = recordingMount(async () => ({
			status: 201,
			headers: { "content-type": "application/json; charset=utf-8", "x-cd": "yes" },
			body: encoder.encode(JSON.stringify({ ok: true, value: { id: "x" } })),
		}));
		const server = await start(mount);
		const res = await fetch(`${server.url}/v1/cd/leases?camp=eu-1`, {
			method: "POST",
			headers: { "content-type": "application/json", DPoP: "proof", Authorization: "DPoP svid" },
			body: JSON.stringify({ campId: "eu-1" }),
		});
		expect(res.status).toBe(201);
		expect(res.headers.get("x-cd")).toBe("yes");
		expect(await res.json()).toEqual({ ok: true, value: { id: "x" } });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.path).toBe("/v1/cd/leases?camp=eu-1");
		expect(seen[0]?.headers.dpop).toBe("proof");
		expect(seen[0]?.headers.authorization).toBe("DPoP svid");
		expect(new TextDecoder().decode(seen[0]?.body)).toBe(JSON.stringify({ campId: "eu-1" }));
	});

	it("streams an async-iterable body (SSE) chunk by chunk", async () => {
		const { mount } = recordingMount(async () => ({
			status: 200,
			headers: { "content-type": "text/event-stream; charset=utf-8" },
			body: (async function* () {
				yield encoder.encode("id: 1\nevent: freight.Recorded\ndata: {}\n\n");
				await new Promise((r) => setTimeout(r, 10));
				yield encoder.encode("event: end\ndata: {}\n\n");
			})(),
		}));
		const server = await start(mount);
		const res = await fetch(`${server.url}/v1/cd/stream`, { headers: { "Last-Event-ID": "0" } });
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
		const body = await res.text();
		expect(body).toContain("event: freight.Recorded");
		expect(body).toContain("event: end");
	});

	it("aborts the handler's signal when the client disconnects", async () => {
		let aborted: Promise<void> = Promise.resolve();
		const { mount } = recordingMount(async (_req, signal) => {
			aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: (async function* () {
					yield encoder.encode(": open\n\n");
					while (!signal.aborted) await new Promise((r) => setTimeout(r, 5));
				})(),
			};
		});
		const server = await start(mount);
		await new Promise<void>((resolve) => {
			const req = httpRequest(`${server.url}/v1/cd/stream`, (res) => {
				res.once("data", () => {
					req.destroy();
					resolve();
				});
			});
			req.end();
		});
		await expect(Promise.race([aborted.then(() => "aborted"), new Promise((r) => setTimeout(() => r("timeout"), 2_000))])).resolves.toBe("aborted");
	});

	it("a stream that fails after headers are sent ends the response instead of crashing the server", async () => {
		const { mount } = recordingMount(async () => ({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: (async function* () {
				yield encoder.encode("id: 1\nevent: x\ndata: {}\n\n");
				throw new Error("journal lost");
			})(),
		}));
		const server = await start(mount);
		const body = await (await fetch(`${server.url}/v1/cd/stream`)).text();
		expect(body).toContain("id: 1");
		expect((await fetch(`${server.url}/health`)).status).toBe(200);
	});

	it("refuses an oversized body with 413 before calling the handler", async () => {
		const { mount, seen } = recordingMount(async () => ({ status: 200, headers: {}, body: new Uint8Array() }));
		const server = await start(mount);
		const res = await fetch(`${server.url}/v1/cd/observations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(8 * 1024 * 1024 + 1),
		});
		expect(res.status).toBe(413);
		expect(seen).toHaveLength(0);
	});

	it("a handler that throws becomes a 500 envelope, not a dropped connection", async () => {
		const { mount } = recordingMount(async () => {
			throw new Error("boom");
		});
		const server = await start(mount);
		const res = await fetch(`${server.url}/v1/cd/camps`);
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ ok: false, code: "internal" });
	});

	it("merges the CD OpenAPI paths and schemas into /v1/openapi.json", async () => {
		const { mount } = recordingMount(async () => ({ status: 200, headers: {}, body: new Uint8Array() }));
		const server = await start(mount);
		const doc = (await (await fetch(`${server.url}/v1/openapi.json`)).json()) as {
			paths: Record<string, unknown>;
			components?: { schemas?: Record<string, unknown> };
		};
		expect(doc.paths["/v1/cd/camps"]).toEqual({ get: { summary: "Camp inventory" } });
		expect(doc.paths["/v1/station/status"]).toBeDefined();
		expect(doc.components?.schemas?.CampList).toEqual({ type: "object" });
	});

	it("without a CD mount, /v1/cd/ is a 404 and the OpenAPI has no CD paths", async () => {
		const server = await start();
		const res = await fetch(`${server.url}/v1/cd/camps`);
		expect(res.status).toBe(404);
		const doc = (await (await fetch(`${server.url}/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
		expect(Object.keys(doc.paths).some((p) => p.startsWith("/v1/cd/"))).toBe(false);
	});
});
