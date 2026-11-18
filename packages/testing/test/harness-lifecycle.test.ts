import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestHarness } from "../src/harness.js";

const lane = { deploy: vi.fn(), destroy: vi.fn() };
const harnessForTest = () =>
	createTestHarness(
		{},
		{
			deployInProcess: lane.deploy,
			destroyInProcess: lane.destroy,
		},
	);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((finish, fail) => {
		resolve = finish;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function deployment(id: number) {
	return {
		id,
		stage: "test",
		handles: new Map(),
		bindings: {},
		servers: new Map(),
		topology: { nodes: [], edges: [] },
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
	lane.deploy.mockReset();
	lane.destroy.mockReset();
});

describe("harness deployment lifecycle", () => {
	it("shares starts and teardown, and waits to redeploy until teardown finishes", async () => {
		for (const startCount of [1, 2, 3, 4]) {
			for (const stopCount of [1, 2, 3, 4]) {
				for (const restartCount of [1, 2, 3, 4]) {
					lane.deploy.mockReset();
					lane.destroy.mockReset();
					const start = deferred<ReturnType<typeof deployment>>();
					const stop = deferred<readonly string[]>();
					lane.deploy
						.mockReturnValueOnce(start.promise)
						.mockResolvedValue(deployment(2));
					lane.destroy.mockReturnValue(stop.promise);
					const harness = harnessForTest();
					const bindle = {};
					const initial = Array.from({ length: startCount }, () =>
						harness.deploy(bindle)(),
					);
					let stopped = 0;
					const stops = Array.from({ length: stopCount }, () =>
						harness
							.destroy(bindle)()
							.then(() => {
								stopped += 1;
							}),
					);
					const restarts = Array.from({ length: restartCount }, () =>
						harness.deploy(bindle)(),
					);
					try {
						await flushMicrotasks();
						expect(lane.deploy).toHaveBeenCalledTimes(1);
						start.resolve(deployment(1));
						await flushMicrotasks();
						expect(lane.destroy).toHaveBeenCalledTimes(1);
						expect(stopped).toBe(0);
						expect(lane.deploy).toHaveBeenCalledTimes(1);
						stop.resolve([]);
						const [first, , second] = await Promise.all([
							Promise.all(initial),
							Promise.all(stops),
							Promise.all(restarts),
						]);
						expect(lane.deploy).toHaveBeenCalledTimes(2);
						expect(first.every((graph) => graph === first[0])).toBe(true);
						expect(second.every((graph) => graph === second[0])).toBe(true);
						expect(first[0]).not.toBe(second[0]);
					} finally {
						start.resolve(deployment(1));
						stop.resolve([]);
						await Promise.allSettled([...initial, ...stops, ...restarts]);
					}
				}
			}
		}
	});

	it("keeps a failed teardown fenced until a retry succeeds", async () => {
		const failure = new Error("teardown did not complete");
		lane.deploy.mockResolvedValue(deployment(1));
		lane.destroy.mockRejectedValueOnce(failure).mockResolvedValue([]);
		const harness = harnessForTest();
		const bindle = {};
		await harness.deploy(bindle)();
		await expect(harness.destroy(bindle)()).rejects.toBe(failure);
		await expect(harness.deploy(bindle)()).rejects.toBe(failure);
		expect(lane.deploy).toHaveBeenCalledTimes(1);
		await harness.destroy(bindle)();
		await harness.deploy(bindle)();
		expect(lane.destroy).toHaveBeenCalledTimes(2);
		expect(lane.deploy).toHaveBeenCalledTimes(2);
	});

	it("rejects all teardown and redeploy waiters when teardown fails", async () => {
		const stop = deferred<readonly string[]>();
		const failure = new Error("teardown did not complete");
		lane.deploy.mockResolvedValue(deployment(1));
		lane.destroy.mockReturnValueOnce(stop.promise).mockResolvedValue([]);
		const harness = harnessForTest();
		const bindle = {};
		await harness.deploy(bindle)();
		const first = harness.destroy(bindle)();
		const second = harness.destroy(bindle)();
		const redeploy = harness.deploy(bindle)();
		const outcomes = Promise.allSettled([first, second, redeploy]);
		stop.reject(failure);
		expect(await outcomes).toEqual(
			Array.from({ length: 3 }, () => ({
				status: "rejected",
				reason: failure,
			})),
		);
		expect(lane.deploy).toHaveBeenCalledTimes(1);
		await harness.destroy(bindle)();
		await harness.deploy(bindle)();
		expect(lane.deploy).toHaveBeenCalledTimes(2);
	});

	it("shares a start even when deployment synchronously reenters the harness", async () => {
		const harness = harnessForTest();
		const bindle = {};
		let reentrant: Promise<unknown> | undefined;
		lane.deploy.mockResolvedValue(deployment(2)).mockImplementationOnce(() => {
			reentrant = harness.deploy(bindle)();
			return Promise.resolve(deployment(1));
		});
		const first = await harness.deploy(bindle)();
		expect(await reentrant).toBe(first);
		expect(lane.deploy).toHaveBeenCalledTimes(1);
	});

	it("propagates a failed start to waiters and permits a later retry", async () => {
		const start = deferred<ReturnType<typeof deployment>>();
		const failure = new Error("start failed");
		lane.deploy
			.mockReturnValueOnce(start.promise)
			.mockResolvedValue(deployment(2));
		const harness = harnessForTest();
		const bindle = {};
		const first = harness.deploy(bindle)();
		const close = harness.destroy(bindle)();
		const retryWhileClosing = harness.deploy(bindle)();
		const outcomes = Promise.allSettled([first, close, retryWhileClosing]);
		start.reject(failure);
		expect(await outcomes).toEqual(
			Array.from({ length: 3 }, () => ({
				status: "rejected",
				reason: failure,
			})),
		);
		await harness.deploy(bindle)();
		expect(lane.deploy).toHaveBeenCalledTimes(2);
	});
});
