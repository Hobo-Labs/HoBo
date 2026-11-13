// O19 (rotation half): during the rotation of each key, a device that
// refreshes every second sees zero refused requests, and when the rotation
// ends only the new key is published.
import { KeyPurpose } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import { type Reached, rotate } from "../../src/ops/rotation.js";
import { readSecret, readSlot, slotName } from "../../src/ops/slots.js";
import { NATS_KEYS } from "./device.js";
import {
	ALL_KEYS,
	rotateWhileRefreshing,
	rotationSetup,
} from "./rotation-setup.js";

describe("O19 rotation without an outage", () => {
	it.each(
		ALL_KEYS,
	)("rotates %s with zero refused requests from a device refreshing every second", async (which) => {
		const setup = await rotationSetup();
		try {
			const reached = await rotateWhileRefreshing(setup, which, async () => {
				const result = await rotate(setup.deps(), which);
				if (!result.ok) throw new Error(result.error.message);
				return result.value.reached;
			});
			expect(reached.at(-1)).toBe<Reached>("done");
			expect(setup.dev.refreshes()).toBeGreaterThan(600);
			expect(setup.dev.refusals).toEqual([]);

			const { secrets } = setup.fixture;
			const prefix = setup.fixture.prefix;
			if (which === "token-signing") {
				const ring = await readSecret(secrets, slotName(prefix, which));
				const kids = JSON.parse(ring.ok ? (ring.value ?? "{}") : "{}").keys.map(
					(entry: { kid: string }) => entry.kid,
				);
				expect(kids).toEqual([`${slotName(prefix, which)}#2`]);
				return;
			}
			const slot = await readSlot(secrets, prefix, which);
			if (!slot.ok || slot.value === undefined) throw new Error("no slot");
			expect(slot.value.keys.map((key) => key.kid)).toEqual([
				slot.value.active,
			]);
			expect(slot.value.active.endsWith("#2")).toBe(true);
			const pinned = setup.dev.pinned();
			if (which === "record-signing")
				expect(pinned.authorityKeys.map((key) => key.keyId)).toEqual([
					"authority#2",
				]);
			else if (which === "witness")
				expect(
					pinned.witnessKeys
						.filter((key) => key.purpose === KeyPurpose.WITNESS)
						.map((key) => key.keyId),
				).toEqual(["witness#2"]);
			else if (NATS_KEYS.includes(which))
				expect(setup.nats.published.get(which)).toEqual([
					slot.value.keys[0]?.publicKey,
				]);
		} finally {
			await setup.dep.stop();
		}
	}, 60_000);
});
