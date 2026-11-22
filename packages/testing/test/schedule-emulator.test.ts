import {
	parseIdempotencyKey,
	parseQueueName,
	parseRunId,
	parseScheduleId,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createQueueEmulator,
	createScheduleEmulator,
	createTestHarness,
	deployInProcess,
	destroyInProcess,
	type ScheduleDriver,
	ScheduleHandlerError,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

function app() {
	return fakeBindle({
		resources: {
			inbox: { kind: "queue" },
			nightly: { kind: "schedule", dependsOn: ["inbox"] },
			other: { kind: "schedule", dependsOn: ["inbox"] },
			cache: { kind: "kv" },
		},
		handlers: {},
	});
}

async function scheduleLifecycle(
	kind: "harness" | "in-process",
	onScheduleClose: () => void,
	onQueueClose: () => void,
) {
	const bindle = fakeBindle({
		resources: {
			inbox: { kind: "queue" },
			nightly: { kind: "schedule", dependsOn: ["inbox"] },
		},
		handlers: {},
	});
	const emulators = {
		queue: () => ({ ...createQueueEmulator(), close: onQueueClose }),
		schedule: () => {
			const schedule = createScheduleEmulator();
			const original = schedule.driver;
			if (!original) throw new Error("Schedule driver unavailable.");
			const driver: ScheduleDriver = {
				registerJob(scheduleId, spec, handler) {
					return original.registerJob(scheduleId, spec, handler);
				},
				advance(deltaMs) {
					return original.advance(deltaMs);
				},
			};
			return {
				...schedule,
				driver,
				async close() {
					onScheduleClose();
					await schedule.close?.();
				},
			};
		},
	};
	if (kind === "harness") {
		const harness = createTestHarness({ emulators });
		const graph = await harness.deploy(bindle)();
		const driver = graph.scheduleDriver("nightly");
		if (!driver) throw new Error("Schedule driver unavailable.");
		return { driver, destroy: harness.destroy(bindle) };
	}
	const deployment = await deployInProcess(bindle, "test", emulators);
	const driver = deployment.schedules.get("nightly")?.driver;
	if (!driver) throw new Error("Schedule driver unavailable.");
	return {
		driver,
		async destroy() {
			await destroyInProcess(deployment);
		},
	};
}

describe("in-process schedules", () => {
	it("registers idempotent interval schedules and advances time deterministically", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const schedule = graph.schedule("nightly");
			const id = parseScheduleId("nightly");
			expect(schedule.every(id, { everyMs: 1000 }).deduped).toBe(false);
			expect(schedule.every(id, { everyMs: 1000 }).deduped).toBe(true);
			expect(
				graph
					.scheduleClock("nightly")
					?.advance(3000)
					.map((fire) => fire.occurrence),
			).toEqual([1, 2, 3]);
			expect(graph.scheduleClock("other")?.advance(3000)).toEqual([]);
			expect(graph.resource("nightly").fidelity).toBe("simulated");
			expect(() => graph.schedule("cache")).toThrowError(
				expect.objectContaining({ code: "HARNESS_EMULATOR_UNAVAILABLE" }),
			);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it.each([
		"driver",
		"port",
		"clock",
	] as const)("keeps the original %s schedule while replacing its handler", async (source) => {
		const emulator = createScheduleEmulator();
		const { driver, clock } = emulator;
		if (!driver || !clock) throw new Error("Schedule driver unavailable.");
		const id = parseScheduleId("repair");
		const start = clock.nowMs();
		const originalSpec = { everyMs: 1000, startAtMs: start + 1000 };
		const handled: string[] = [];
		const oldHandler = () => {
			handled.push("old");
		};
		const registered =
			source === "driver"
				? driver.registerJob(id, originalSpec, oldHandler)
				: source === "port"
					? emulator.port.every(id, originalSpec)
					: clock.cron(id, originalSpec);
		expect(registered.deduped).toBe(false);
		if (source !== "driver")
			expect(driver.registerJob(id, originalSpec, oldHandler).deduped).toBe(
				true,
			);
		const replacement = driver.registerJob(
			id,
			{ everyMs: 5000, startAtMs: start + 9000 },
			() => {
				handled.push("new");
			},
		);
		expect(replacement).toMatchObject({
			scheduleId: id,
			deduped: true,
			everyMs: 1000,
			nextFireAt: registered.nextFireAt,
		});
		expect((await driver.advance(1000)).map((fire) => fire.occurrence)).toEqual(
			[1],
		);
		expect(handled).toEqual(["new"]);
		await emulator.close?.();
	});

	it("retains the collected batch's handler after re-registration", async () => {
		const emulator = createScheduleEmulator();
		const driver = emulator.driver;
		if (!driver) throw new Error("Schedule driver unavailable.");
		const id = parseScheduleId("repair");
		const handled: string[] = [];
		driver.registerJob(id, { everyMs: 1000 }, (fire) => {
			handled.push(`old:${fire.occurrence}`);
			if (fire.occurrence === 1) {
				const replacement = driver.registerJob(
					id,
					{ everyMs: 5000 },
					(next) => {
						handled.push(`new:${next.occurrence}`);
					},
				);
				expect(replacement).toMatchObject({ deduped: true, everyMs: 1000 });
			}
		});
		await driver.advance(3000);
		expect(handled).toEqual(["old:1", "old:2", "old:3"]);
		await driver.advance(1000);
		expect(handled).toEqual(["old:1", "old:2", "old:3", "new:4"]);
		await emulator.close?.();
	});

	it("awaits registered worker handlers in fire order", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const driver = graph.scheduleDriver("nightly");
			if (!driver) throw new Error("Schedule driver unavailable.");
			const queue = graph.queue("inbox");
			const name = parseQueueName("inbox");
			const start = graph.scheduleClock("nightly")?.nowMs();
			const observedTimes: (number | undefined)[] = [];
			driver.registerJob(
				parseScheduleId("repair"),
				{ everyMs: 1000 },
				async (fire) => {
					observedTimes.push(graph.scheduleClock("nightly")?.nowMs());
					await queue.enqueue(
						name,
						{ occurrence: fire.occurrence },
						{
							idempotencyKey: parseIdempotencyKey(
								JSON.stringify(["nightly", fire.fireId]),
							),
						},
					);
				},
			);
			expect(
				(await driver.advance(3000)).map((fire) => fire.occurrence),
			).toEqual([1, 2, 3]);
			expect(
				queue.dequeue(name, { maxMessages: 3 }).map((item) => item.body),
			).toEqual([{ occurrence: 1 }, { occurrence: 2 }, { occurrence: 3 }]);
			expect(graph.scheduleClock("nightly")?.nowMs()).toBe((start ?? 0) + 3000);
			expect(observedTimes).toEqual(Array(3).fill((start ?? 0) + 3000));
			expect(await graph.scheduleDriver("other")?.advance(3000)).toEqual([]);
			expect(graph.resource("nightly").fidelity).toBe("simulated");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("namespaces fire IDs when different schedules share a queue", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const queue = graph.queue("inbox");
			const name = parseQueueName("inbox");
			const ids: string[] = [];
			for (const alias of ["nightly", "other"]) {
				const driver = graph.scheduleDriver(alias);
				if (!driver) throw new Error("Schedule driver unavailable.");
				driver.registerJob(
					parseScheduleId("repair"),
					{ everyMs: 1000 },
					async (fire) => {
						ids.push(fire.fireId);
						await queue.enqueue(
							name,
							{ alias },
							{
								idempotencyKey: parseIdempotencyKey(
									JSON.stringify([alias, fire.fireId]),
								),
							},
						);
					},
				);
				await driver.advance(1000);
			}
			expect(ids).toEqual(["cron:repair:1", "cron:repair:1"]);
			expect(
				queue.dequeue(name, { maxMessages: 2 }).map((item) => item.body),
			).toEqual([{ alias: "nightly" }, { alias: "other" }]);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("consumes raw clock fires without delivering them to the driver", async () => {
		const emulator = createScheduleEmulator();
		const { driver, clock } = emulator;
		if (!driver || !clock) throw new Error("Schedule driver unavailable.");
		const handled: number[] = [];
		driver.registerJob(parseScheduleId("repair"), { everyMs: 1000 }, (fire) => {
			if (fire.occurrence !== undefined) handled.push(fire.occurrence);
		});
		expect(clock.advance(1000).map((fire) => fire.occurrence)).toEqual([1]);
		expect(await driver.advance(0)).toEqual([]);
		expect((await driver.advance(1000)).map((fire) => fire.occurrence)).toEqual(
			[2],
		);
		expect(handled).toEqual([2]);
		await emulator.close?.();
	});

	it("registers synchronously while an advance is waiting to start", async () => {
		const emulator = createScheduleEmulator();
		const driver = emulator.driver;
		if (!driver) throw new Error("Schedule driver unavailable.");
		const handled: string[] = [];
		const advancing = driver.advance(1000);
		driver.registerJob(parseScheduleId("later"), { everyMs: 1000 }, (fire) => {
			handled.push(String(fire.scheduleId));
		});
		expect((await advancing).map((fire) => fire.scheduleId)).toEqual(["later"]);
		expect(handled).toEqual(["later"]);
		await emulator.close?.();
	});

	it("defers jobs registered by a handler until the next advance", async () => {
		const emulator = createScheduleEmulator();
		const { driver, clock } = emulator;
		if (!driver || !clock) throw new Error("Schedule driver unavailable.");
		const handled: string[] = [];
		driver.registerJob(parseScheduleId("first"), { everyMs: 1000 }, () => {
			handled.push("first");
			driver.registerJob(
				parseScheduleId("second"),
				{ everyMs: 1000, startAtMs: clock.nowMs() },
				() => {
					handled.push("second");
				},
			);
		});
		expect((await driver.advance(1000)).map((fire) => fire.scheduleId)).toEqual(
			["first"],
		);
		expect(handled).toEqual(["first"]);
		expect((await driver.advance(0)).map((fire) => fire.scheduleId)).toEqual([
			"second",
		]);
		expect(handled).toEqual(["first", "second"]);
		await emulator.close?.();
	});

	it("advances schedules registered through the shared port without a worker", async () => {
		const emulator = createScheduleEmulator();
		const driver = emulator.driver;
		if (!driver) throw new Error("Schedule driver unavailable.");
		emulator.port.every(parseScheduleId("port-only"), { everyMs: 1000 });
		expect((await driver.advance(1000)).map((fire) => fire.scheduleId)).toEqual(
			["port-only"],
		);
		await emulator.close?.();
	});

	it("identifies each worker failure after running the remaining due fires", async () => {
		const emulator = createScheduleEmulator();
		const { driver, clock } = emulator;
		if (!driver || !clock) throw new Error("Schedule driver unavailable.");
		const start = clock.nowMs();
		const alphaFailure = new Error("synthetic worker failure");
		const betaFailure = new Error("synthetic worker failure");
		const handled: string[] = [];
		for (const id of ["alpha", "beta"]) {
			driver.registerJob(parseScheduleId(id), { everyMs: 1000 }, (fire) => {
				handled.push(`${id}:${fire.occurrence}`);
				if (id === "alpha" && fire.occurrence === 1) throw alphaFailure;
				if (id === "beta" && fire.occurrence === 1) throw betaFailure;
				if (id === "beta" && fire.occurrence === 2)
					return Promise.reject("synthetic signal");
			});
		}
		try {
			await driver.advance(3000);
			throw new Error("Expected scheduled handlers to fail.");
		} catch (error) {
			if (!(error instanceof AggregateError)) throw error;
			expect(error.errors).toHaveLength(3);
			const [alpha, beta, signal] = error.errors;
			for (const failure of error.errors)
				expect(failure).toBeInstanceOf(ScheduleHandlerError);
			expect(alpha).toMatchObject({
				fire: { scheduleId: "alpha", fireId: "cron:alpha:1", occurrence: 1 },
			});
			expect(alpha.message).toContain('schedule "alpha"');
			expect(alpha.message).toContain("cron:alpha:1");
			expect(alpha.cause).toBe(alphaFailure);
			expect(beta).toMatchObject({
				fire: { scheduleId: "beta", fireId: "cron:beta:1", occurrence: 1 },
			});
			expect(beta.message).toContain('schedule "beta"');
			expect(beta.message).toContain("cron:beta:1");
			expect(beta.cause).toBe(betaFailure);
			expect(signal).toMatchObject({
				fire: { scheduleId: "beta", fireId: "cron:beta:2", occurrence: 2 },
			});
			expect(signal.cause).toBe("synthetic signal");
		}
		expect(handled).toEqual([
			"alpha:1",
			"beta:1",
			"alpha:2",
			"beta:2",
			"alpha:3",
			"beta:3",
		]);
		expect(clock.nowMs()).toBe(start + 3000);
		expect(await driver.advance(0)).toEqual([]);
		expect(handled).toHaveLength(6);
		await emulator.close?.();
	});

	it("keeps simultaneous fires in the virtual clock's deterministic order", async () => {
		const emulator = createScheduleEmulator();
		const driver = emulator.driver;
		const clock = emulator.clock;
		if (!driver || !clock) throw new Error("Schedule driver unavailable.");
		const handled: string[] = [];
		for (const id of ["zeta", "alpha"]) {
			driver.registerJob(parseScheduleId(id), { everyMs: 1000 }, (fire) => {
				handled.push(String(fire.scheduleId));
			});
		}
		clock.sleep(parseRunId("fixture-run"), 1000, {
			idempotencyKey: "fixture-sleep",
		});
		const fires = await driver.advance(1000);
		expect(fires.map((fire) => [fire.kind, fire.scheduleId])).toEqual([
			["cron", "alpha"],
			["cron", "zeta"],
			["sleep", undefined],
		]);
		expect(handled).toEqual(["alpha", "zeta"]);
		await emulator.close?.();
	});

	it("serializes overlapping advances and protects the raw clock while workers run", async () => {
		const emulator = createScheduleEmulator();
		const driver = emulator.driver;
		const clock = emulator.clock;
		if (!driver || !clock) throw new Error("Schedule driver unavailable.");
		let started = () => {};
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handled: number[] = [];
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async (fire) => {
				if (fire.occurrence !== undefined) handled.push(fire.occurrence);
				if (fire.occurrence === 1) {
					started();
					await wait;
				}
			},
		);
		const first = driver.advance(1000);
		await running;
		const second = driver.advance(1000);
		try {
			expect(handled).toEqual([1]);
			expect(() => clock.advance(1000)).toThrow(/advance is in progress/u);
		} finally {
			release();
		}
		expect((await first).map((fire) => fire.occurrence)).toEqual([1]);
		expect((await second).map((fire) => fire.occurrence)).toEqual([2]);
		expect(handled).toEqual([1, 2]);
		await emulator.close?.();
	});

	it("waits for an active graph worker and refuses queued or late work on teardown", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle({
			resources: { nightly: { kind: "schedule" } },
			handlers: {},
		});
		const graph = await harness.deploy(bindle)();
		const driver = graph.scheduleDriver("nightly");
		if (!driver) throw new Error("Schedule driver unavailable.");
		let started = () => {};
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handled: number[] = [];
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async (fire) => {
				if (fire.occurrence !== undefined) handled.push(fire.occurrence);
				started();
				await wait;
			},
		);
		const first = driver.advance(1000);
		await running;
		const second = driver.advance(1000);
		const rejected = expect(second).rejects.toThrow(/closed/u);
		let closed = false;
		const closing = harness
			.destroy(bindle)()
			.then(() => {
				closed = true;
			});
		try {
			await Promise.resolve();
			expect(closed).toBe(false);
		} finally {
			release();
		}
		await first;
		await rejected;
		await closing;
		expect(handled).toEqual([1]);
		await expect(driver.advance(1000)).rejects.toThrow(/closed/u);
	});

	it.each([
		"harness",
		"in-process",
	] as const)("refuses reentrant %s teardown before closing dependencies", async (kind) => {
		const closed: string[] = [];
		const { driver, destroy } = await scheduleLifecycle(
			kind,
			() => {
				closed.push("schedule");
			},
			() => {
				closed.push("queue");
			},
		);
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async () => {
				await expect(destroy()).rejects.toThrow(
					/cannot destroy its own graph/u,
				);
				expect(closed).toEqual([]);
			},
		);
		expect(await driver.advance(1000)).toHaveLength(1);
		expect(closed).toEqual([]);
		await destroy();
		expect(closed).toEqual(["schedule", "queue"]);
	});

	it.each([
		"harness",
		"in-process",
	] as const)("refuses reentrant %s teardown even after external teardown starts", async (kind) => {
		const closed: string[] = [];
		let markClosing = () => {};
		const startedClosing = new Promise<void>((resolve) => {
			markClosing = resolve;
		});
		const { driver, destroy } = await scheduleLifecycle(
			kind,
			() => {
				closed.push("schedule");
				markClosing();
			},
			() => {
				closed.push("queue");
			},
		);
		let markRunning = () => {};
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			markRunning = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async () => {
				markRunning();
				await wait;
				await expect(destroy()).rejects.toThrow(
					/cannot destroy its own graph/u,
				);
				expect(closed).toEqual(["schedule"]);
			},
		);
		const advancing = driver.advance(1000);
		await running;
		const closing = destroy();
		await startedClosing;
		release();
		await advancing;
		await closing;
		expect(closed).toEqual(["schedule", "queue"]);
	});

	it("preserves a replacement graph when an older worker tries teardown", async () => {
		let markClosing = () => {};
		const startedClosing = new Promise<void>((resolve) => {
			markClosing = resolve;
		});
		const harness = createTestHarness({
			emulators: {
				schedule: () => {
					const schedule = createScheduleEmulator();
					return {
						...schedule,
						async close() {
							markClosing();
							await schedule.close?.();
						},
					};
				},
			},
		});
		const bindle = fakeBindle({
			resources: { nightly: { kind: "schedule" } },
			handlers: {},
		});
		const original = await harness.deploy(bindle)();
		const driver = original.scheduleDriver("nightly");
		if (!driver) throw new Error("Schedule driver unavailable.");
		let markRunning = () => {};
		let release = () => {};
		const running = new Promise<void>((resolve) => {
			markRunning = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async () => {
				markRunning();
				await wait;
				await expect(harness.destroy(bindle)()).rejects.toThrow(
					/cannot destroy its own graph/u,
				);
			},
		);
		const advancing = driver.advance(1000);
		await running;
		const closing = harness.destroy(bindle)();
		await startedClosing;
		const pending = harness.deploy(bindle)();
		release();
		await advancing;
		await closing;
		const replacement = await pending;
		expect(replacement).not.toBe(original);
		expect(await harness.deploy(bindle)()).toBe(replacement);
		await harness.destroy(bindle)();
	});

	it("allows a worker to destroy a different graph", async () => {
		const harness = createTestHarness();
		const first = fakeBindle({
			resources: { nightly: { kind: "schedule" } },
			handlers: {},
		});
		const second = fakeBindle({
			resources: { other: { kind: "schedule" } },
			handlers: {},
		});
		const graph = await harness.deploy(first)();
		const other = await harness.deploy(second)();
		const driver = graph.scheduleDriver("nightly");
		if (!driver) throw new Error("Schedule driver unavailable.");
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async () => {
				await harness.destroy(second)();
			},
		);
		await driver.advance(1000);
		expect(await harness.deploy(second)()).not.toBe(other);
		await harness.destroy(first)();
		await harness.destroy(second)();
	});

	it("guards a pre-registered worker on a wrapped custom driver", async () => {
		const bindle = fakeBindle({
			resources: { nightly: { kind: "schedule" } },
			handlers: {},
		});
		const schedule = createScheduleEmulator();
		const original = schedule.driver;
		if (!original) throw new Error("Schedule driver unavailable.");
		const driver: ScheduleDriver = {
			registerJob(scheduleId, spec, handler) {
				return original.registerJob(scheduleId, spec, handler);
			},
			advance(deltaMs) {
				return original.advance(deltaMs);
			},
		};
		const harness = createTestHarness({
			emulators: { schedule: () => ({ ...schedule, driver }) },
		});
		original.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async () => {
				await expect(harness.destroy(bindle)()).rejects.toThrow(
					/cannot destroy its own graph/u,
				);
			},
		);
		const graph = await harness.deploy(bindle)();
		const deployedDriver = graph.scheduleDriver("nightly");
		if (!deployedDriver) throw new Error("Schedule driver unavailable.");
		expect(await deployedDriver.advance(1000)).toHaveLength(1);
		expect(await harness.deploy(bindle)()).toBe(graph);
		await harness.destroy(bindle)();
	});

	it("refuses teardown from a worker started while its graph is deploying", async () => {
		const bindle = fakeBindle({
			resources: { nightly: { kind: "schedule" } },
			handlers: {},
		});
		const harness = createTestHarness({
			emulators: {
				schedule: async () => {
					const schedule = createScheduleEmulator();
					if (!schedule.driver) throw new Error("Schedule driver unavailable.");
					schedule.driver.registerJob(
						parseScheduleId("repair"),
						{ everyMs: 1000 },
						async () => {
							await expect(harness.destroy(bindle)()).rejects.toThrow(
								/cannot be destroyed from its own deployment/u,
							);
						},
					);
					await schedule.driver.advance(1000);
					return schedule;
				},
			},
		});
		const graph = await harness.deploy(bindle)();
		expect(graph.scheduleDriver("nightly")).toBeDefined();
		await harness.destroy(bindle)();
	});

	it("refuses reentrant advances and close from a running worker", async () => {
		const emulator = createScheduleEmulator();
		const driver = emulator.driver;
		if (!driver) throw new Error("Schedule driver unavailable.");
		driver.registerJob(
			parseScheduleId("repair"),
			{ everyMs: 1000 },
			async () => {
				await expect(driver.advance(1000)).rejects.toThrow(/own driver/u);
				await expect(emulator.close?.()).rejects.toThrow(/own driver/u);
			},
		);
		expect(await driver.advance(1000)).toHaveLength(1);
		await emulator.close?.();
	});

	it("accepts a replacement without a virtual clock and closes it", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				schedule: () => ({
					port: createScheduleEmulator().port,
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
			},
		});
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		expect(graph.scheduleClock("nightly")).toBeUndefined();
		expect(graph.scheduleDriver("nightly")).toBeUndefined();
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		expect(closed).toBe(2);
	});
});
