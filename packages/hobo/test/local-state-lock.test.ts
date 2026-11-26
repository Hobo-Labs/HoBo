import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	acquireLocalStateLockQueued,
	LocalStateLockBusyError,
	withLocalStateLockQueued,
} from "../src/local-state-lock.js";

it("grants concurrent same-process acquisitions in FIFO order without timers", async () => {
	const grants: number[] = [];
	const schedule = vi.fn((delay: number): Promise<void> => {
		throw new Error(`Unexpected timer wait of ${delay} ms`);
	});
	const acquisitions = [0, 1, 2, 3].map((id) =>
		acquireLocalStateLockQueued(join(tmpdir(), "hobo-local-state-fifo"), {
			acquire: () => () => {},
			schedule,
		}).then((release) => {
			grants.push(id);
			return release;
		}),
	);

	for (let index = 0; index < acquisitions.length; index += 1) {
		const acquisition = acquisitions[index];
		if (!acquisition) throw new Error("Missing acquisition");
		const release = await acquisition;
		expect(grants).toEqual([0, 1, 2, 3].slice(0, index + 1));
		release();
	}
	expect(schedule).not.toHaveBeenCalled();
});

it("releases to the next waiter when a holder throws", async () => {
	const holders: string[] = [];
	const schedule = vi.fn((delay: number): Promise<void> => {
		throw new Error(`Unexpected timer wait of ${delay} ms`);
	});
	const options = { acquire: () => () => {}, schedule };
	const path = join(tmpdir(), "hobo-local-state-holder-error");
	const failing = withLocalStateLockQueued(
		path,
		async () => {
			holders.push("failing");
			throw new Error("holder failed");
		},
		options,
	);
	const succeeding = withLocalStateLockQueued(
		path,
		async () => {
			holders.push("succeeding");
		},
		options,
	);

	await expect(failing).rejects.toThrow("holder failed");
	await succeeding;
	expect(holders).toEqual(["failing", "succeeding"]);
	expect(schedule).not.toHaveBeenCalled();
});

it("retries only the queue head across process contention and preserves the deadline", async () => {
	let now = 0;
	let attempts = 0;
	const retries: Array<() => void> = [];
	const schedule = vi.fn(
		(delay: number): Promise<void> =>
			new Promise((resolve) => {
				expect(delay).toBe(25);
				retries.push(resolve);
			}),
	);
	const options = {
		acquire: () => {
			attempts += 1;
			if (attempts <= 3)
				throw new LocalStateLockBusyError("cross-process busy");
			return () => {};
		},
		now: () => now,
		schedule,
		timeoutMs: 50,
	};
	const path = join(tmpdir(), "hobo-local-state-cross-process");
	const firstOutcome = acquireLocalStateLockQueued(path, options).then(
		() => null,
		(error: Error) => error,
	);
	const second = acquireLocalStateLockQueued(path, options);

	expect(attempts).toBe(1);
	expect(schedule).toHaveBeenCalledTimes(1);
	now = 25;
	const firstRetry = retries.shift();
	if (!firstRetry) throw new Error("Missing first retry");
	firstRetry();
	await Promise.resolve();
	expect(attempts).toBe(2);
	expect(schedule).toHaveBeenCalledTimes(2);

	now = 50;
	const secondRetry = retries.shift();
	if (!secondRetry) throw new Error("Missing second retry");
	secondRetry();
	const [error, releaseSecond] = await Promise.all([firstOutcome, second]);
	expect(error).toBeInstanceOf(LocalStateLockBusyError);
	expect(error).toMatchObject({ message: "cross-process busy" });
	expect(attempts).toBe(4);
	expect(schedule).toHaveBeenCalledTimes(2);
	releaseSecond();
});
