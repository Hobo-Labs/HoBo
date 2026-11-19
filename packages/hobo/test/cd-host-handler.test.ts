/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Yard fixtures are partial records cast once to the type under test. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FeedResponse } from "@hobo/cd";
import { describe, expect, it } from "vitest";

import { composeCdHost } from "../src/cd-host.js";
import { openCdRuntime } from "../src/cd-runtime.js";

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
		yards: [yard("edge", [{ id: "prod", envType: "production" }])],
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
const json = (body: FeedResponse["body"]) => {
	if (!(body instanceof Uint8Array)) throw new Error("expected a whole body");
	return JSON.parse(new TextDecoder().decode(body));
};

describe("composeCdHost", () => {
	it("is ready once composed when no loop runs", async () => {
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
			const openapi = await host.handle(
				get(`${host.pathPrefix}openapi.json`),
				signal,
			);
			expect(openapi.status).toBe(200);
		});
	});

	it("is not ready by the service rule until its loop starts", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({ runtime, holderId: "test-loop" });
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
		});
	});

	it("runs one bounded pass", async () => {
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

	it("refuses pass without ticking when the conductor did not compose", async () => {
		await withRuntime(async (runtime) => {
			const refusing = {
				...runtime,
				conductor: () => {
					throw new Error("conductor refused");
				},
			};
			const host = await composeCdHost({
				runtime: refusing,
				holderId: "test-refused",
				readiness: "composed",
			});
			expect(host.refusals).toContain("conductor refused");
			await expect(host.pass()).rejects.toThrow("conductor refused");
		});
	});

	it("runs only one pass at a time", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-flight",
				readiness: "composed",
			});
			const first = host.pass();
			const second = host.pass();
			expect(first).toBe(second);
			await first;
		});
	});
});
