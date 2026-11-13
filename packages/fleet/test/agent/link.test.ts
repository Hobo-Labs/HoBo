/**
 * The agent's bus link: one `FleetBus` over whichever connection is current.
 * With none, calls reject and status reads "disconnected"; a subscription
 * outlives its connection and, on the next one, resumes after the last
 * sequence its handler took, so nothing is handed twice or missed.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { createMemoryConnector } from "../../examples/memory-connector.js";
import {
	DiscoverySchema,
	KeyAlgorithm,
	SignedEnvelopeSchema,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import { createBusLink } from "../../src/agent/link.js";
import { parseFleetId, parseMemberId, parseWorkDigest } from "../../src/ids.js";
import { createMemoryKeyStore } from "../../src/keys/index.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";

const FLEET = parseFleetId("hobo");
const SELF = parseMemberId(`dev_${"1".repeat(32)}`);
const now = () => Date.parse("2026-11-13T12:00:00.000Z");

const envelope = (marker: number) =>
	create(SignedEnvelopeSchema, {
		context: "hobo-fleet/offer/v1",
		keyId: `${SELF}#sign`,
		algorithm: KeyAlgorithm.EDDSA,
		payload: new Uint8Array([marker]),
		signature: new Uint8Array(64),
	});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("createBusLink", () => {
	it("rejects calls and reads disconnected while no connection is attached", async () => {
		const link = createBusLink();
		expect(link.bus.status()).toBe("disconnected");
		expect(link.current()).toBeUndefined();
		await expect(link.bus.offers.publish(envelope(1), FLEET)).rejects.toThrow(
			/not connected/,
		);
		await expect(link.bus.registry.member(SELF)).rejects.toThrow(
			/not connected/,
		);
		expect(() => link.bus.registry.trust()).toThrow(/not connected/);
		await link.close();
		expect(link.bus.status()).toBe("closed");
	});

	it("resumes every kind of subscription after the last sequence it handled", async () => {
		const memory = createMemoryBus(now);
		const connector = createMemoryConnector(memory);
		const link = createBusLink();
		const seen = new Map<string, number[]>();
		const note = (kind: string) => async (sequence: number) => {
			seen.set(kind, [...(seen.get(kind) ?? []), sequence]);
		};
		link.bus.offers.subscribe([FLEET], "start", async (_offer, sequence) =>
			note("offers")(sequence),
		);
		link.bus.submissions.subscribe([FLEET], "start", async (_s, sequence) =>
			note("submissions")(sequence),
		);
		link.bus.orders.subscribe(SELF, "start", async (_o, sequence) =>
			note("orders")(sequence),
		);
		link.bus.orders.observeAll("start", async (_o, _to, sequence) =>
			note("all-orders")(sequence),
		);
		link.bus.events.subscribe(
			["receipt"],
			"start",
			async (_e, _m, _k, sequence) => note("events")(sequence),
		);
		link.bus.control.subscribe(SELF, "start", async (_c, sequence) =>
			note("control")(sequence),
		);
		link.bus.claims.subscribe([FLEET], "start", async (_c, _f, _d, sequence) =>
			note("claims")(sequence),
		);
		const frames: string[] = [];
		link.bus.relay.subscribe(SELF, async (sessionId) => {
			frames.push(sessionId);
		});

		const publishAll = async (marker: number) => {
			await memory.offers.publish(envelope(marker), FLEET);
			await memory.submissions.publish(envelope(marker), FLEET);
			await memory.orders.deliver(envelope(marker), SELF);
			await memory.events.publish(envelope(marker), SELF, "receipt");
			await memory.control.send(envelope(marker), SELF);
			await memory.claims.claim(
				envelope(marker),
				FLEET,
				parseWorkDigest(String(marker).repeat(32)),
			);
			await memory.relay.send(SELF, `s${marker}`, new Uint8Array([marker]));
		};

		const keys = await createMemoryKeyStore().open();
		const connect = () =>
			connector.connect({
				discovery: create(DiscoverySchema, {}),
				keys,
				trust: create(WitnessedEnvelopeSchema, {}),
				ticket: async () => envelope(0),
				resumeFrom: {},
				log: () => {},
			});

		await publishAll(1);
		link.attach(await connect());
		await settle();
		await publishAll(2);
		await settle();
		await link.detach();
		expect(link.bus.status()).toBe("disconnected");
		await publishAll(3);
		link.attach(await connect());
		await settle();
		for (const kind of [
			"offers",
			"submissions",
			"orders",
			"all-orders",
			"events",
			"control",
			"claims",
		])
			expect({ kind, sequences: seen.get(kind) }).toEqual({
				kind,
				sequences: [1, 2, 3],
			});
		// Relay frames have no stream: only those sent while attached arrive.
		expect(frames).toEqual(["s2"]);
		await link.close();
		expect(link.bus.status()).toBe("closed");
	});
});
