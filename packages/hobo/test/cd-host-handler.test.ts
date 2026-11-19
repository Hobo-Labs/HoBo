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

import { composeCdHost, HOST_PASS_SUCCEEDED } from "../src/cd-host.js";
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
			expect(host.refusals).toContain("cd-host-refused");
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

	it("refuses readiness by code when the topology has no MANAGED camps", async () => {
		await withRuntime(async (runtime) => {
			const camps: readonly CampTopology[] = [
				campTopology("edge/watched", CampManagement.OBSERVE_ONLY),
			];
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
			};
			const host = await composeCdHost({
				runtime: overridden,
				holderId: "test-no-managed",
				readiness: "composed",
			});
			expect(host.managed).toEqual([]);
			expect(host.refusals).toContain("cd-no-managed-camps");
			const report = await host.pass();
			expect(report.skipped).toBe(false);
			const recorded: string[] = [];
			for await (const event of runtime.store.read(
				`${runtime.config.tenant}:cd-host-pass`,
			))
				recorded.push(event.type);
			expect(recorded).toEqual([]);
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
		});
	});

	it("stays not ready when every camp fails to reconcile", async () => {
		await withRuntime(async (runtime) => {
			const failing: TestRuntime = {
				...runtime,
				conductor: () =>
					fakeReconciler(
						async () =>
							({
								reasons: [
									{
										code: "reconcile-failed",
										message: "the provider refused",
										remediation: "fix the camp",
									},
								],
								status: 0,
							}) as never,
					),
			};
			const host = await composeCdHost({
				runtime: failing,
				holderId: "test-all-failed",
				readiness: "composed",
			});
			const report = await host.pass();
			expect(report.skipped).toBe(false);
			expect(report.reconciled.every((entry) => !entry.ok)).toBe(true);
			const recorded: string[] = [];
			for await (const event of runtime.store.read(
				`${runtime.config.tenant}:cd-host-pass`,
			))
				recorded.push(event.type);
			expect(recorded).toEqual([]);
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
			expect(json(ready.body)).toMatchObject({
				readiness: "composed",
				refusals: [],
			});
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
			const recorded: unknown[] = [];
			for await (const event of runtime.store.read(
				`${runtime.config.tenant}:cd-host-pass`,
			))
				recorded.push(event.data);
			expect(recorded).toEqual([
				{ atMs: Date.UTC(2026, 10, 17), campIds: ["edge/prod"] },
			]);
		});
	});

	it("skips the pass while another holder holds the fleet pass lease", async () => {
		await withRuntime(async (runtime) => {
			let releaseGate = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			let signalEntered = () => {};
			const entered = new Promise<void>((resolve) => {
				signalEntered = resolve;
			});
			const gated: TestRuntime = {
				...runtime,
				conductor: () =>
					fakeReconciler(async () => {
						signalEntered();
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
			await entered;
			try {
				const skipped = await second.pass(AbortSignal.timeout(5_000));
				expect(skipped.skipped).toBe(true);
				expect(skipped.reconciled).toEqual([]);
			} finally {
				releaseGate();
			}
			const completed = await running;
			expect(completed.skipped).toBe(false);
		});
	});

	it("bounds a pass by its deadline and frees the slot once the bounded pass settles", async () => {
		await withRuntime(async (runtime) => {
			const signals: (AbortSignal | undefined)[] = [];
			let calls = 0;
			const slow: TestRuntime = {
				...runtime,
				conductor: () =>
					fakeReconciler(async (_campId, ctx) => {
						calls += 1;
						signals.push(ctx.signal);
						await new Promise<void>((resolve, reject) => {
							if (ctx.signal?.aborted) {
								reject(
									ctx.signal.reason instanceof Error
										? ctx.signal.reason
										: new Error("cd pass aborted"),
								);
								return;
							}
							const timer = setTimeout(resolve, 150);
							ctx.signal?.addEventListener(
								"abort",
								() => {
									clearTimeout(timer);
									reject(
										ctx.signal?.reason instanceof Error
											? ctx.signal.reason
											: new Error("cd pass aborted"),
									);
								},
								{ once: true },
							);
						});
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
			const second = host.pass();
			expect(second).toBe(first);
			await expect(second).rejects.toThrow("cd pass deadline exceeded");
			expect(signals[0]?.aborted).toBe(true);
			expect(calls).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const third = host.pass();
			expect(third).not.toBe(first);
			await expect(third).rejects.toThrow("cd pass deadline exceeded");
			expect(calls).toBe(2);
			expect(signals[1]?.aborted).toBe(true);
		});
	});

	it("frees the pass slot at the deadline while the ghost run keeps the fleet lease", async () => {
		await withRuntime(async (runtime) => {
			let releaseGate = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			let signalEntered = () => {};
			const entered = new Promise<void>((resolve) => {
				signalEntered = resolve;
			});
			const gated: TestRuntime = {
				...runtime,
				conductor: () =>
					fakeReconciler(async () => {
						signalEntered();
						await gate;
						return { reasons: [], status: 0 } as never;
					}),
			};
			const stalled = await composeCdHost({
				runtime: gated,
				holderId: "test-deadline-lease-a",
				readiness: "composed",
				fleetPassLease: true,
				passDeadlineMs: 30,
			});
			const peer = await composeCdHost({
				runtime: gated,
				holderId: "test-deadline-lease-b",
				readiness: "composed",
				fleetPassLease: true,
			});
			const ghost = stalled.pass();
			await entered;
			await new Promise((resolve) => setTimeout(resolve, 40));
			const successor = stalled.pass();
			expect(successor).not.toBe(ghost);
			const queued = await peer.pass();
			expect(queued.skipped).toBe(true);
			expect(queued.skipReason).toBe("fleet-pass-lease-held");
			releaseGate();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await expect(ghost).rejects.toThrow("cd pass deadline exceeded");
			const settled = await stalled.pass();
			expect(settled.skipped).toBe(false);
		});
	});

	it("ignores a pass record that reconciled fewer camps than it manages", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-forged-record",
				readiness: "composed",
			});
			await runtime.store.append(
				`${runtime.config.tenant}:cd-host-pass`,
				[
					{
						type: HOST_PASS_SUCCEEDED,
						data: { atMs: Date.UTC(2026, 10, 17), campIds: [] },
					},
				],
				{
					expectedSeq: 0,
					actor: { kind: "service", id: "test-forged-record" },
					tenant: runtime.config.tenant,
				},
			);
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
		});
	});

	it("ignores a legacy pass record that stores only a camp count", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-legacy-record",
				readiness: "composed",
			});
			await runtime.store.append(
				`${runtime.config.tenant}:cd-host-pass`,
				[
					{
						type: HOST_PASS_SUCCEEDED,
						data: { atMs: Date.UTC(2026, 10, 17), camps: 1 },
					},
				],
				{
					expectedSeq: 0,
					actor: { kind: "service", id: "test-legacy-record" },
					tenant: runtime.config.tenant,
				},
			);
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
		});
	});

	it("refuses composed readiness after camp replacement until a matching pass", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-camp-swap-a",
				readiness: "composed",
			});
			await host.pass();
			const readyBefore = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(readyBefore.status).toBe(200);
			const camps: readonly CampTopology[] = [
				campTopology("edge/preview", CampManagement.MANAGED),
			];
			const swapped: TestRuntime = {
				...runtime,
				cd: {
					...runtime.cd,
					topology: {
						camps: async () => camps,
						camp: async (campId: CampId) =>
							camps.find((camp) => camp.campId === campId),
					},
				},
			};
			const afterSwap = await composeCdHost({
				runtime: swapped,
				holderId: "test-camp-swap-b",
				readiness: "composed",
			});
			expect(afterSwap.managed).toEqual(["edge/preview"]);
			const readyAfterSwap = await afterSwap.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(readyAfterSwap.status).toBe(503);
			await afterSwap.pass();
			const readyAfterPass = await afterSwap.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(readyAfterPass.status).toBe(200);
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
			expect(host.refusals).toContain("cd-host-refused");
			await expect(host.pass()).rejects.toThrow("cd-host-refused");
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
			const [firstReport, secondReport] = await Promise.all([first, second]);
			expect(secondReport).toBe(firstReport);
		});
	});

	it("shares one bounded promise across concurrent pass callers", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-shared-flight",
				readiness: "composed",
			});
			const first = host.pass();
			const second = host.pass();
			expect(second).toBe(first);
			const [firstReport, secondReport] = await Promise.all([first, second]);
			expect(secondReport).toBe(firstReport);
		});
	});

	it("records successful passes on the tenant-scoped stream only", async () => {
		await withRuntime(async (runtime) => {
			const host = await composeCdHost({
				runtime,
				holderId: "test-tenant-stream",
				readiness: "composed",
			});
			await host.pass();
			const scoped: string[] = [];
			for await (const event of runtime.store.read(
				`${runtime.config.tenant}:cd-host-pass`,
			))
				scoped.push(event.type);
			expect(scoped).toContain(HOST_PASS_SUCCEEDED);
			const bare: string[] = [];
			for await (const event of runtime.store.read("cd-host-pass"))
				bare.push(event.type);
			expect(bare).toEqual([]);
		});
	});

	it("fails the pass when the successful pass cannot be recorded", async () => {
		await withRuntime(async (runtime) => {
			const append = runtime.store.append.bind(runtime.store);
			runtime.store.append = async (streamId, events, opts) => {
				if (streamId.endsWith("cd-host-pass"))
					throw new Error("journal append refused");
				return append(streamId, events, opts);
			};
			const host = await composeCdHost({
				runtime,
				holderId: "test-record-failure",
				readiness: "composed",
			});
			await expect(host.pass()).rejects.toMatchObject({
				code: "cd-host-pass-record-failed",
			});
			const ready = await host.handle(
				get("/readyz"),
				AbortSignal.timeout(5_000),
			);
			expect(ready.status).toBe(503);
		});
	});

	it("rejects pass records from the future or past the readiness window", async () => {
		await withRuntime(async (runtime) => {
			const base = Date.UTC(2026, 10, 17);
			let nowMs = base;
			const clocked: TestRuntime = {
				...runtime,
				ctx: { ...runtime.ctx, now: () => nowMs },
			};
			const host = await composeCdHost({
				runtime: clocked,
				holderId: "test-pass-ages",
				readiness: "composed",
			});
			await host.pass();
			const signal = AbortSignal.timeout(5_000);
			expect((await host.handle(get("/readyz"), signal)).status).toBe(200);
			nowMs = base - 60_000;
			expect((await host.handle(get("/readyz"), signal)).status).toBe(503);
			nowMs = base + 600_000;
			expect((await host.handle(get("/readyz"), signal)).status).toBe(503);
			nowMs = base + 60_000;
			expect((await host.handle(get("/readyz"), signal)).status).toBe(200);
		});
	});
});
