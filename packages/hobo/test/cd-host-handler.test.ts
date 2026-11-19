/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Yard fixtures are partial records cast once to the type under test. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CampId,
	CampManagement,
	type CampTopology,
	type CdContext,
	type FeedResponse,
	type ReconcileObservationRecord,
} from "@hobo/cd";
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

type TestRuntime = Extract<
	Awaited<ReturnType<typeof openCdRuntime>>,
	{ ok: true }
>["value"];

function fakeReconciler(
	reconcileOnce: (
		campId: CampId,
		ctx: CdContext,
	) => Promise<ReconcileObservationRecord>,
) {
	return {
		reconcilerId: "test-reconciler",
		mode: 0,
		run: async () => {},
		reconcileOnce,
	} as never;
}

function campTopology(
	campId: string,
	management: CampManagement,
): CampTopology {
	return {
		campId: campId as CampId,
		yardId: "edge",
		stationId: "station",
		provider: "vercel",
		regions: ["us-east-1"],
		envType: "production",
		labels: {},
		management,
	};
}

describe("composeCdHost", () => {
	it("is ready in composed mode only after one successful pass", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-fn",
				readiness: "composed",
			});
			const signal = AbortSignal.timeout(5_000);
			expect((await host.handle(get("/healthz"), signal)).status).toBe(200);
			const beforePass = await host.handle(get("/readyz"), signal);
			expect(beforePass.status).toBe(503);
			await host.pass();
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

	it("is not ready in service mode while composition refusals stand", async () => {
		await withRuntime(async (runtime) => {
			const refusing: TestRuntime = {
				...runtime,
				conductor: () => {
					throw new Error("conductor refused");
				},
			};
			const host = await composeCdHost({
				runtime: refusing,
				holderId: "test-service-refused",
			});
			expect(host.refusals).toContain("conductor refused");
			await host.service.start();
			try {
				expect(host.service.ready()).toBe(true);
				const ready = await host.handle(
					get("/readyz"),
					AbortSignal.timeout(5_000),
				);
				expect(ready.status).toBe(503);
			} finally {
				await host.service.drain(AbortSignal.timeout(5_000));
			}
		});
	});

	it("manages only camps with MANAGED management", async () => {
		await withRuntime(async (runtime) => {
			const camps: readonly CampTopology[] = [
				campTopology("edge/managed", CampManagement.MANAGED),
				campTopology("edge/watched", CampManagement.OBSERVE_ONLY),
				campTopology("edge/unknown", CampManagement.UNSPECIFIED),
			];
			const conducted: (readonly CampId[])[] = [];
			const overridden: TestRuntime = {
				...runtime,
				cd: {
					...runtime.cd,
					topology: {
						camps: async () => camps,
						camp: async (campId: CampId) =>
							camps.find((camp) => camp.campId === campId),
					},
				},
				conductor: (campIds: readonly CampId[]) => {
					conducted.push(campIds);
					return fakeReconciler(
						async () => ({ reasons: [], status: 0 }) as never,
					);
				},
			};
			const host = await composeCdHost({
				runtime: overridden,
				holderId: "test-managed",
				readiness: "composed",
			});
			expect(host.managed).toEqual(["edge/managed"]);
			expect(conducted).toEqual([["edge/managed"]]);
		});
	});

	it("runs one bounded pass", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-pass",
				readiness: "composed",
			});
			const { tick, reconciled, skipped } = await host.pass();
			expect(skipped).toBe(false);
			expect(host.managed).toEqual(["edge/prod"]);
			expect(reconciled.map((r) => r.campId)).toEqual(["edge/prod"]);
			expect(tick.steps.length).toBeGreaterThan(0);
		});
	});

	it("skips the pass while another holder holds the fleet pass lease", async () => {
		await withRuntime(async (runtime) => {
			let releaseGate = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			const gated: TestRuntime = {
				...runtime,
				conductor: () =>
					fakeReconciler(async () => {
						await gate;
						return { reasons: [], status: 0 } as never;
					}),
			};
			const first = await composeCdHost({
				runtime: gated,
				holderId: "test-fleet-a",
				readiness: "composed",
				fleetPassLease: true,
			});
			const second = await composeCdHost({
				runtime: gated,
				holderId: "test-fleet-b",
				readiness: "composed",
				fleetPassLease: true,
			});
			const running = first.pass();
			const skipped = await second.pass();
			expect(skipped.skipped).toBe(true);
			expect(skipped.reconciled).toEqual([]);
			releaseGate();
			const completed = await running;
			expect(completed.skipped).toBe(false);
		});
	});

	it("bounds a pass by its deadline and clears the flight on timeout", async () => {
		await withRuntime(async (runtime) => {
			const signals: (AbortSignal | undefined)[] = [];
			let calls = 0;
			const slow: TestRuntime = {
				...runtime,
				conductor: () =>
					fakeReconciler(async (_campId, ctx) => {
						calls += 1;
						signals.push(ctx.signal);
						await new Promise((resolve) => setTimeout(resolve, 150));
						return { reasons: [], status: 0 } as never;
					}),
			};
			const host = await composeCdHost({
				runtime: slow,
				holderId: "test-deadline",
				readiness: "composed",
				passDeadlineMs: 30,
			});
			const first = host.pass();
			await expect(first).rejects.toThrow("cd pass deadline exceeded");
			expect(signals[0]?.aborted).toBe(true);
			const second = host.pass();
			expect(second).not.toBe(first);
			await expect(second).rejects.toThrow("cd pass deadline exceeded");
			expect(calls).toBe(2);
			await new Promise((resolve) => setTimeout(resolve, 200));
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
