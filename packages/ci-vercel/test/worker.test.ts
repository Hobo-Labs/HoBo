import { describe, expect, it, vi } from "vitest";
import {
	createHostedWorker,
	QueueMessageSchema,
	runRepairs,
	type WorkerHealth,
	withRepairStage,
} from "../src/worker.js";

const scheduled = { source: "static", name: "hobo-ci-repair" };
function setup() {
	const marks: [string, boolean][] = [];
	const health: WorkerHealth = {
		mark: async (component, ok) => {
			marks.push([component, ok]);
		},
		ready: async () =>
			["queue", "schedule", "repair"].every((component) =>
				marks.some(([name, ok]) => name === component && ok),
			),
	};
	const tick = vi.fn(async () => {});
	const repair = vi.fn(async () => ({ truncated: false, more: false }));
	return {
		marks,
		tick,
		repair,
		worker: createHostedWorker({
			health,
			tick,
			repair,
			continueRepair: async () => {},
		}),
	};
}

describe("hosted worker", () => {
	it("records each completed repair cycle independently across wakeups", async () => {
		const marks: [number, boolean, string][] = [];
		let clock = 0;
		const evidence = {
			start: async () => String(++clock),
			finish: async (index: number, ok: boolean, at: string) => {
				marks.push([index, ok, at]);
			},
		};
		await runRepairs(
			[
				async () => ({ more: false, truncated: false }),
				async () => ({ more: true, truncated: false, skipped: true }),
			],
			evidence,
		);
		expect(marks).toEqual([[0, true, "1"]]);
		await runRepairs(
			[
				async () => ({ more: true, truncated: false }),
				async () => ({ more: false, truncated: false }),
			],
			evidence,
		);
		expect(marks).toEqual([
			[0, true, "1"],
			[1, true, "4"],
		]);
		await runRepairs(
			[
				async () => ({ more: true, truncated: true }),
				async () => ({ more: false, truncated: false, failed: true }),
			],
			evidence,
		);
		expect(marks.slice(2)).toEqual([
			[0, false, "5"],
			[1, false, "6"],
		]);
	});
	it("continues repair and preserves failures when the logging sink throws", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("logging unavailable");
		});
		try {
			await expect(
				withRepairStage("repair-database", async () => {
					throw new Error("original failure");
				}),
			).rejects.toThrow("original failure");
			const later = vi.fn(async () => ({ more: false, truncated: false }));
			const result = await runRepairs([
				async () => {
					throw new Error("scanner failed");
				},
				later,
			]);
			expect(later).toHaveBeenCalledOnce();
			expect(result.failed).toBe(true);
		} finally {
			log.mockRestore();
		}
	});
	it("reports fixed stages and safe statuses without logging exception details", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				withRepairStage("repair-database", async () => {
					throw new Error("postgres://private:secret@example.test/db");
				}),
			).rejects.toThrow();
			await runRepairs([
				async () => {
					throw new Error("GitHub deliveries lookup failed (403)");
				},
				async () => ({ more: false, truncated: false, failed: true }),
			]);
			const messages = log.mock.calls.map(([message]) => String(message));
			expect(messages).toEqual([
				JSON.stringify({
					event: "hobo_ci_worker_failure",
					stage: "repair-database",
				}),
				JSON.stringify({
					event: "hobo_ci_worker_failure",
					stage: "repair-scanner",
					scanner: 0,
					status: 403,
				}),
				JSON.stringify({
					event: "hobo_ci_worker_failure",
					stage: "repair-scanner",
					scanner: 1,
				}),
			]);
			expect(messages.join(" ")).not.toContain("secret");
		} finally {
			log.mockRestore();
		}
	});
	it("rejects messages that combine wakeup and repair identities", () => {
		expect(
			QueueMessageSchema.safeParse({
				deliveryId: "id",
				source: "static",
				name: "hobo-ci-repair",
			}).success,
		).toBe(false);
		expect(
			QueueMessageSchema.safeParse({ deliveryId: "id", metadata: "provider" })
				.success,
		).toBe(true);
		expect(
			QueueMessageSchema.safeParse({
				source: "static",
				name: "hobo-ci-repair",
				scheduleId: "provider",
			}).success,
		).toBe(true);
	});
	it("runs repair scanners sequentially and continues after one scanner fails", async () => {
		const order: string[] = [];
		const result = await runRepairs([
			async () => {
				order.push("first");
				throw new Error("private");
			},
			async () => {
				order.push("second");
				return { more: true, truncated: false };
			},
		]);
		expect(order).toEqual(["first", "second"]);
		expect(result).toEqual({ failed: true, more: true, truncated: false });
	});
	it("separates immediate webhook wakeups from scheduled GitHub delivery repair", async () => {
		const { worker, tick, repair, marks } = setup();
		await worker.run({ deliveryId: "abc" });
		expect(tick).toHaveBeenCalledOnce();
		expect(repair).not.toHaveBeenCalled();
		expect(marks).toEqual([["queue", true]]);
		expect(await worker.ready()).toBe(false);
		await worker.run(scheduled);
		expect(repair).toHaveBeenCalledOnce();
		expect(await worker.ready()).toBe(true);
	});
	it("continues durable inbox processing even if GitHub repair fails, and reports degraded health", async () => {
		const marks: [string, boolean][] = [];
		const tick = vi.fn(async () => {});
		const worker = createHostedWorker({
			continueRepair: async () => {},
			tick,
			repair: async () => {
				throw new Error("private detail");
			},
			health: {
				mark: async (c, ok) => {
					marks.push([c, ok]);
				},
				ready: async () => false,
			},
		});
		await expect(worker.run(scheduled)).rejects.toThrow("hosted worker failed");
		expect(tick).toHaveBeenCalledOnce();
		expect(marks).toEqual([
			["queue", true],
			["repair", false],
			["schedule", false],
		]);
	});
	it("still repairs missed deliveries when inbox processing fails", async () => {
		const marks: [string, boolean][] = [];
		const repair = vi.fn(async () => ({ truncated: false, more: false }));
		const worker = createHostedWorker({
			continueRepair: async () => {},
			tick: async () => {
				throw new Error("private");
			},
			repair,
			health: {
				mark: async (c, ok) => {
					marks.push([c, ok]);
				},
				ready: async () => false,
			},
		});
		await expect(worker.run(scheduled)).rejects.toThrow("hosted worker failed");
		expect(repair).toHaveBeenCalledOnce();
		expect(marks).toEqual([
			["queue", false],
			["repair", true],
			["schedule", false],
		]);
	});
	it("fails closed when the GitHub scan is incomplete", async () => {
		const marks: [string, boolean][] = [];
		const worker = createHostedWorker({
			continueRepair: async () => {},
			tick: async () => {},
			repair: async () => ({ truncated: true, more: false }),
			health: {
				mark: async (c, ok) => {
					marks.push([c, ok]);
				},
				ready: async () => false,
			},
		});
		await expect(worker.run(scheduled)).rejects.toThrow();
		expect(marks).toEqual([
			["queue", true],
			["repair", false],
			["schedule", false],
		]);
	});
	it("queues a bounded continuation without impersonating a scheduled heartbeat", async () => {
		const marks: [string, boolean][] = [];
		const continuation = vi.fn(async () => {});
		const worker = createHostedWorker({
			tick: async () => {},
			repair: async () => ({ truncated: false, more: true }),
			continueRepair: continuation,
			health: {
				mark: async (component, ok) => {
					marks.push([component, ok]);
				},
				ready: async () => false,
			},
		});
		await worker.run({ source: "hobo-ci", name: "hobo-ci-repair" });
		expect(continuation).toHaveBeenCalledOnce();
		expect(marks).toEqual([["queue", true]]);
	});
	it("keeps completed-scan health during progress without clearing a real failure", async () => {
		const health = new Map<string, boolean>();
		let phase = 0;
		const worker = createHostedWorker({
			tick: async () => {},
			repair: async () => {
				phase++;
				if (phase === 4) throw new Error("repair failed");
				return { truncated: false, more: [1, 3, 5].includes(phase) };
			},
			continueRepair: async () => {},
			health: {
				mark: async (component, ok) => {
					health.set(component, ok);
				},
				ready: async () =>
					["queue", "schedule", "repair"].every(
						(component) => health.get(component) === true,
					),
			},
		});
		await worker.run(scheduled);
		expect(await worker.ready()).toBe(false);
		await worker.run({ source: "hobo-ci", name: "hobo-ci-repair" });
		expect(await worker.ready()).toBe(true);
		await worker.run({ source: "hobo-ci", name: "hobo-ci-repair" });
		expect(await worker.ready()).toBe(true);
		await expect(
			worker.run({ source: "hobo-ci", name: "hobo-ci-repair" }),
		).rejects.toThrow("hosted worker failed");
		expect(await worker.ready()).toBe(false);
		await worker.run({ source: "hobo-ci", name: "hobo-ci-repair" });
		expect(await worker.ready()).toBe(false);
		await worker.run({ source: "hobo-ci", name: "hobo-ci-repair" });
		expect(await worker.ready()).toBe(true);
	});
	it("expires the last complete scan despite repeated partial progress", async () => {
		let now = 0;
		let complete = true;
		const success = new Map<string, number>();
		const worker = createHostedWorker({
			tick: async () => {},
			repair: async () => ({ truncated: false, more: !complete }),
			continueRepair: async () => {},
			health: {
				mark: async (component, ok) => {
					if (ok) success.set(component, now);
					else success.delete(component);
				},
				ready: async () =>
					["queue", "schedule", "repair"].every((component) => {
						const at = success.get(component);
						return at !== undefined && now - at < 45 * 60_000;
					}),
			},
		});
		await worker.run(scheduled);
		expect(await worker.ready()).toBe(true);
		complete = false;
		for (const minutes of [15, 30, 44]) {
			now = minutes * 60_000;
			await worker.run(scheduled);
			expect(await worker.ready()).toBe(true);
		}
		now = 45 * 60_000;
		await worker.run(scheduled);
		expect(await worker.ready()).toBe(false);
	});
});
