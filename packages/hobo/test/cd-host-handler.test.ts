import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { composeCdHost } from "../src/cd-host.js";
import { openCdRuntime } from "../src/cd-runtime.js";

// The CD service's mount without a server: what a platform function calls,
// one request (`handle`) or one schedule (`pass`) at a time.

async function withRuntime(
	body: (
		runtime: Extract<
			Awaited<ReturnType<typeof openCdRuntime>>,
			{ ok: true }
		>["value"],
	) => Promise<void>,
) {
	const home = await mkdtemp(join(tmpdir(), "hobo-cd-host-"));
	const opened = await openCdRuntime({
		env: {},
		home,
		cwd: home,
		simulate: true,
		now: () => Date.UTC(2026, 10, 17),
		// One Yard with one MANAGED Camp, so a pass has something to reconcile.
		// SAFETY: a partial Yard record, the fields yardTopology reads.
		yards: [
			{
				kind: "yard",
				name: "edge",
				providerId: "vercel",
				regions: ["us-east-1"],
				labels: {},
				camps: [
					{ kind: "camp", id: "prod", envType: "production", labels: {} },
				],
			} as never,
		],
	});
	if (!opened.ok) throw new Error(JSON.stringify(opened.reasons));
	try {
		await body(opened.value);
	} finally {
		await opened.value.close();
		await rm(home, { recursive: true, force: true });
	}
}

const get = (path: string) => ({
	method: "GET",
	path,
	headers: {},
	body: new Uint8Array(),
});
const json = (body: unknown) =>
	JSON.parse(new TextDecoder().decode(body as Uint8Array));

describe("composeCdHost: the CD mount as a request handler", () => {
	it("is ready once composed when no loop runs (a platform function)", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-fn",
				readiness: "composed",
			});
			const signal = AbortSignal.timeout(5_000);
			expect((await host.handle(get("/healthz"), signal)).status).toBe(200);
			const ready = await host.handle(get("/readyz"), signal);
			expect(ready.status).toBe(200);
			expect(json(ready.body)).toMatchObject({
				readiness: "composed",
				refusals: [],
			});
			expect((await host.handle(get("/elsewhere"), signal)).status).toBe(404);
			// The read API answers under the mount.
			const openapi = await host.handle(
				get(`${host.pathPrefix}openapi.json`),
				signal,
			);
			expect(openapi.status).toBe(200);
		});
	});

	it("is not ready by the service's own rule until its loop starts", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({ runtime, holderId: "test-loop" });
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
		});
	});

	it("runs one bounded pass: every managed Camp once, then one tick", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-pass",
				readiness: "composed",
			});
			const { tick, reconciled } = await host.pass();
			expect(host.managed).toEqual(["edge/prod"]);
			expect(reconciled.map((r) => r.campId)).toEqual(["edge/prod"]);
			expect(tick.steps.length).toBeGreaterThan(0);
		});
	});
});
