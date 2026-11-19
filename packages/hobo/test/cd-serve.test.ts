/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Yard fixtures are partial records cast once to the type under test. */

import { mkdtemp, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openCdRuntime } from "../src/cd-runtime.js";
import { startCdServer } from "../src/cd-serve.js";

function yard(name: string, camps: { id: string; envType: string }[]) {
	return {
		kind: "yard",
		name,
		providerId: "vercel",
		regions: ["us-east-1"],
		labels: {},
		camps: camps.map((c) => ({
			kind: "camp",
			id: c.id,
			envType: c.envType,
			labels: {},
		})),
	} as never;
}

async function withServer(
	body: (
		server: Awaited<ReturnType<typeof startCdServer>>,
		lines: string[],
	) => Promise<void>,
) {
	const home = await mkdtemp(join(tmpdir(), "hobo-cd-serve-"));
	const opened = await openCdRuntime({
		env: {},
		home,
		cwd: home,
		simulate: true,
		now: () => Date.UTC(2026, 10, 17),
		yards: [yard("edge", [{ id: "prod", envType: "production" }])],
	});
	if (!opened.ok) throw new Error(JSON.stringify(opened.reasons));
	const lines: string[] = [];
	const server = await startCdServer({
		runtime: opened.value,
		host: "127.0.0.1",
		port: 0,
		log: (line) => {
			lines.push(line);
		},
	});
	try {
		await body(server, lines);
	} finally {
		await server.close();
		await rm(home, { recursive: true, force: true });
	}
}

function probeStatusWithoutBody(origin: string, path: string): Promise<number> {
	const target = new URL(path, origin);
	return new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "GET",
				headers: { "Content-Length": "100" },
			},
			(res) => {
				res.resume();
				res.on("end", () => {
					req.destroy();
					resolve(res.statusCode ?? 0);
				});
			},
		);
		req.on("error", reject);
		req.flushHeaders();
		setTimeout(() => {
			req.destroy(new Error(`probe ${path} waited on the request body`));
		}, 5_000).unref();
	});
}

describe("startCdServer probes", () => {
	it("answers /healthz and /readyz without waiting for a request body", async () => {
		await withServer(async (server) => {
			expect(await probeStatusWithoutBody(server.url, "/healthz")).toBe(200);
			const ready = await probeStatusWithoutBody(server.url, "/readyz");
			expect([200, 503]).toContain(ready);
			expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
		});
	});

	it("drains a probe body so a keep-alive socket serves the next request", async () => {
		await withServer(async (server) => {
			const agent = new Agent({ keepAlive: true });
			try {
				const first = await new Promise<number>((resolve, reject) => {
					const req = httpRequest(
						{
							hostname: "127.0.0.1",
							port: server.port,
							path: "/healthz",
							method: "GET",
							agent,
							headers: { "Content-Length": "100" },
						},
						(res) => {
							res.resume();
							res.on("end", () => {
								req.end(".".repeat(93));
								resolve(res.statusCode ?? 0);
							});
						},
					);
					req.on("error", reject);
					req.write("partial");
					req.flushHeaders();
				});
				expect(first).toBe(200);
				const second = await new Promise<number>((resolve, reject) => {
					const req = httpRequest(
						{
							hostname: "127.0.0.1",
							port: server.port,
							path: "/healthz",
							method: "GET",
							agent,
						},
						(res) => {
							res.resume();
							res.on("end", () => resolve(res.statusCode ?? 0));
						},
					);
					req.on("error", reject);
					req.end();
				});
				expect(second).toBe(200);
			} finally {
				agent.destroy();
			}
		});
	});

	it("logs the cause and answers a generic 500 when a request fails", async () => {
		await withServer(async (server, lines) => {
			const response = await fetch(`${server.url}/v1/cd/freight`, {
				method: "POST",
				body: new Uint8Array(4 * 1024 * 1024 + 1),
			});
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({
				ok: false,
				code: "cd-serve-error",
			});
			expect(
				lines.some((line) => line.includes("hobo serve cd: request failed:")),
			).toBe(true);
		});
	});
});
