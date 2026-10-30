import { describe, expect, it } from "vitest";
import {
	preferDegradesFromNative,
	TARGET_CAPABILITY_PACKS,
} from "./target-capability-packs.js";

describe("Matching-honest target capability packs", () => {
	it("lakebed native ports exclude queue/container fiction", () => {
		const pack = TARGET_CAPABILITY_PACKS.lakebed;
		expect(pack.native).toEqual(
			expect.arrayContaining(["compute", "kv", "objectStore", "database"]),
		);
		expect(pack.native).not.toContain("queue");
		expect(pack.preferDegrades.queue).toBe("memory");
		expect(pack.supportsAnonymousTemporaryDeploy).toBe(true);
		expect(pack.canHostNow).toBe(true);
	});

	it("cloudflare native ports match Workers/KV/R2 only", () => {
		const pack = TARGET_CAPABILITY_PACKS.cloudflare;
		expect(pack.native).toEqual(
			expect.arrayContaining(["compute", "kv", "objectStore"]),
		);
		expect(pack.preferDegrades.queue).toBe("memory");
		expect(pack.preferDegrades.container).toMatch(/not native/);
	});

	it("does not advertise account-backed Vercel CLI as anonymous temporary hosting", () => {
		expect(TARGET_CAPABILITY_PACKS.vercel.canHostNow).toBe(false);
		expect("railway" in TARGET_CAPABILITY_PACKS).toBe(false);
		expect(
			TARGET_CAPABILITY_PACKS.vercel.supportsAnonymousTemporaryDeploy,
		).toBe(false);
		expect(TARGET_CAPABILITY_PACKS.vercel.unavailableReason).toMatch(
			/anonymous temporary deployment API/,
		);
	});

	it("preferDegradesFromNative mirrors Matching prefer lowers", () => {
		expect(preferDegradesFromNative(["compute", "http"])).toMatchObject({
			kv: "memory",
			queue: "memory",
		});
	});
});
