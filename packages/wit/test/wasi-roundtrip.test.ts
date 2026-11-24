import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	EXPECTED_ROUND_TRIP_INTERFACES,
	loadToolchainLock,
	roundTripFixture,
	verifyVendoredWit,
} from "../src/index.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = join(PACKAGE_ROOT, "wit-lock.json");

describe("wasi:* round-trip shape identity", () => {
	it("covers kv, blobstore, config, and logging fixtures", () => {
		expect(EXPECTED_ROUND_TRIP_INTERFACES).toEqual([
			"wasi:keyvalue/store@0.2.0",
			"wasi:blobstore/blobstore@0.2.0",
			"wasi:config/store@0.2.0",
			"wasi:logging/logging@0.2.0",
		]);
	});

	it("preserves fixture shapes through encode/decode round-trip", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		for (const interfaceRef of EXPECTED_ROUND_TRIP_INTERFACES) {
			const result = await roundTripFixture(interfaceRef, lock, PACKAGE_ROOT);
			expect(result.interfaceRef).toBe(interfaceRef);
			expect(result.decoded).toEqual(result.input);
		}
	});

	it("fails closed when vendored hash drifts during round-trip", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const drifted = {
			...lock,
			witDeps: lock.witDeps.map((pin, index) =>
				index === 0 ? { ...pin, sha256: `${pin.sha256.slice(0, -1)}0` } : pin,
			),
		};

		await expect(
			roundTripFixture("wasi:keyvalue/store@0.2.0", drifted, PACKAGE_ROOT),
		).rejects.toMatchObject({ code: "wit.digest_mismatch" });
	});

	it("verifies all vendored WASI pins", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const verification = await verifyVendoredWit(lock, PACKAGE_ROOT);
		const wasiPins = lock.witDeps.filter((pin) => pin.namespace === "wasi");
		expect(wasiPins).toHaveLength(14);
		expect(verification.verified).toBe(lock.witDeps.length);
	});
});
