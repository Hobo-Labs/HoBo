import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	type BoundedDeadline,
	boundedOperation,
} from "../src/bounded-operation.js";

vi.hoisted(() => vi.resetModules());

function deadline(milliseconds = 1_000) {
	return {
		expired: false,
		expiresAt: BigInt(milliseconds) * 1_000_000n,
		lastObserved: 0n,
		signalTimeout: undefined,
	};
}

describe("bounded operation boundary", () => {
	it.each([
		{ mode: "already-latched", throws: false, notifications: 0 },
		{ mode: "already-latched", throws: true, notifications: 0 },
		{ mode: "signal-latched", throws: false, notifications: 1 },
		{ mode: "signal-latched", throws: true, notifications: 1 },
	] as const)("settles an $mode deadline exactly once when error construction throws=$throws", async ({
		mode,
		throws,
		notifications,
	}) => {
		const limit: BoundedDeadline = deadline();
		if (mode === "already-latched") limit.expired = true;
		const failure = new Error("deadline result");
		const onTimeout = vi.fn();
		const start = vi.fn(() => Promise.resolve(42));
		const error = vi.fn(() => {
			if (throws) throw failure;
			return failure;
		});
		const expired = () => {
			if (mode === "signal-latched") limit.signalTimeout?.();
			return limit.expired;
		};
		await expect(
			boundedOperation(limit, start, onTimeout, expired, error),
		).rejects.toBe(failure);
		expect(start).not.toHaveBeenCalled();
		expect(onTimeout).toHaveBeenCalledTimes(notifications);
		expect(error).toHaveBeenCalledOnce();
	});
	it("restores an existing work promise constructor immediately after observing it", async () => {
		let finish: (value: number) => void = () => {};
		const work = new Promise<number>((resolve) => {
			finish = resolve;
		});
		Object.defineProperty(work, "constructor", {
			value: Promise,
			configurable: true,
			writable: true,
			enumerable: true,
		});
		const original = Object.getOwnPropertyDescriptor(work, "constructor");
		const limit = deadline();
		const result = boundedOperation(
			limit,
			() => work,
			() => {},
			() => limit.expired,
			() => new Error("timeout"),
		);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(Object.getOwnPropertyDescriptor(work, "constructor")).toEqual(
			original,
		);
		finish(42);
		expect((await result).value).toBe(42);
	});

	it("leaves a work promise with no own constructor unchanged", async () => {
		const work = Promise.resolve(3);
		const limit = deadline();
		const result = boundedOperation(
			limit,
			() => work,
			() => {},
			() => limit.expired,
			() => new Error("timeout"),
		);
		expect((await result).value).toBe(3);
		expect(Object.hasOwn(work, "constructor")).toBe(false);
	});

	it("preserves a synchronous start error while the deadline is current", async () => {
		const failure = new Error("start failed");
		const limit = deadline();
		const onTimeout = vi.fn();
		await expect(
			boundedOperation(
				limit,
				() => {
					throw failure;
				},
				onTimeout,
				() => limit.expired,
				() => new Error("timeout"),
			),
		).rejects.toBe(failure);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(limit.expired).toBe(false);
	});

	it("latches, notifies and rejects even if constructing the timeout error throws", async () => {
		const failure = new Error("error construction failed");
		const limit = deadline(10);
		const onTimeout = vi.fn();
		await expect(
			boundedOperation(
				limit,
				() => new Promise<never>(() => {}),
				onTimeout,
				() => limit.expired,
				() => {
					throw failure;
				},
			),
		).rejects.toBe(failure);
		expect(limit.expired).toBe(true);
		expect(onTimeout).toHaveBeenCalledOnce();
	});

	it("expires rather than release a started but unobservable work promise", async () => {
		const pending = Object.freeze(new Promise<never>(() => {}));
		const limit = deadline();
		const onTimeout = vi.fn();
		const timeout = new Error("timeout");
		await expect(
			boundedOperation(
				limit,
				() => pending,
				onTimeout,
				() => limit.expired,
				() => timeout,
			),
		).rejects.toBe(timeout);
		expect(limit.expired).toBe(true);
		expect(onTimeout).toHaveBeenCalledOnce();
	});

	it("keeps exact values boxed while poisoned timers, promise species and descriptor prototypes cannot redirect it", () => {
		const script = fileURLToPath(
			new URL("./bounded-operation-poison.mjs", import.meta.url),
		);
		const result = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 65_536,
		});
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});
