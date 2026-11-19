/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Yard fixtures are partial records cast once to the type under test. */
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
		const server = await startCdServer({
			runtime: opened.value,
			host: "127.0.0.1",
			port: 0,
			log: () => {},
		});
		try {
			expect(await probeStatusWithoutBody(server.url, "/healthz")).toBe(200);
			const ready = await probeStatusWithoutBody(server.url, "/readyz");
			expect([200, 503]).toContain(ready);
			expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});
});
