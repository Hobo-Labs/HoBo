import { createEphemeralRing, parseEphemeralTtlMs } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	bootstrapAssignment,
	readCurrentAssignment,
} from "../../src/assignment/index.js";
import { cacheFleet, testBackend } from "./fixtures.js";

describe("a lost or expired log on a minority, after unrepaired loss", () => {
	it("exposes why an empty quorum cannot prove a fleet is new after unrepaired loss", async () => {
		const fleet = cacheFleet(3);
		fleet.backend("c2").down = true;
		const original = await bootstrapAssignment(fleet.register, "c0");
		expect(original).toMatchObject({
			status: "decided",
			holders: ["c0", "c1"],
		});
		fleet.backend("c2").down = false;
		fleet.backend("c0").down = true;
		fleet.backend("c1").wipe();
		expect(await readCurrentAssignment(fleet.register)).toMatchObject({
			status: "empty",
			silent: ["c0"],
		});
		const conflicting = await bootstrapAssignment(fleet.register, "c2");
		expect(conflicting).toMatchObject({
			status: "decided",
			holders: ["c2", "c1"],
		});
		fleet.backend("c0").down = false;
		const [old] = (await fleet.replicas[0]?.read()) ?? [];
		const [newer] = (await fleet.replicas[2]?.read()) ?? [];
		expect(old?.epoch).toBe(1);
		expect(newer?.epoch).toBe(1);
		expect(old?.active).toBe("c0");
		expect(newer?.active).toBe("c2");
	});

	it("exposes a delayed cross-key ring write after the counter expires", async () => {
		const backend = testBackend("c0");
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const delayed = {
			...backend.state,
			async putIfAbsent(...args: Parameters<typeof backend.state.putIfAbsent>) {
				entered?.();
				await gate;
				return backend.state.putIfAbsent(...args);
			},
		};
		const options = {
			name: "late-write",
			capacity: 5,
			ttlMs: parseEphemeralTtlMs(1_000),
		};
		const old = createEphemeralRing(delayed, options);
		const current = createEphemeralRing(backend.state, options);
		const pending = old.append("old");
		await started;
		backend.nowMs += 1_001;
		release?.();
		await pending;
		await expect(current.append("new-first")).rejects.toThrow(
			/already exists/u,
		);
		await current.append("new-second");
		expect((await current.read(0)).entries.map((item) => item.value)).toEqual([
			"old",
			"new-second",
		]);
	});
});
