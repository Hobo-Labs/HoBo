/**
 * `natsWire` over the fake server of `support/fake-nats.ts`: the bus
 * conformance suite on the authority's ports, then the paths the suite does
 * not reach (status changes, capped reads, refusals the wire passes on).
 * `bus.integration.test.ts` runs the same suite against `nats-server`.
 */
import { runBusConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { authorityBusOverWire } from "../src/bus/fleet-bus.js";
import { BUCKETS, STREAMS } from "../src/bus/names.js";
import { natsWire } from "../src/bus/nats-wire.js";
import { authorityPin, createRegistryView } from "../src/bus/registry-view.js";
import { topologySpecs } from "../src/bus/topology.js";
import type { BusWire } from "../src/bus/wire.js";
import {
	createFakeServer,
	type FakeConnection,
	type FakeServer,
} from "./support/fake-nats.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function provisioned(): FakeServer {
	const server = createFakeServer();
	for (const spec of topologySpecs(1)) server.addStream({ ...spec });
	return server;
}

let consumers = 0;
const consumerName = () => {
	consumers += 1;
	return `consumer_${consumers}`;
};

type Probe = Readonly<{
	wire: BusWire;
	connection: FakeConnection;
	/** The statuses `onStatus` reported. */
	seen: readonly string[];
}>;

/** A wire on a new connection to `server`, recording what it reports. */
function wireOn(server: FakeServer): Probe {
	const connection = server.connect();
	const seen: string[] = [];
	const wire = natsWire(
		connection,
		{ consumerName, onStatus: (status) => seen.push(status) },
		server.clients,
	);
	return { wire, connection, seen };
}

const shared = provisioned();
runBusConformance(async () => {
	const { wire } = wireOn(shared);
	const pin = authorityPin(() => {
		throw new Error("no trust record published yet");
	});
	return authorityBusOverWire(
		wire,
		createRegistryView({ wire, pin, now: Date.now }),
		pin,
		Date.now,
	);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("natsWire", () => {
	it("reports disconnect, reconnect and close, and closes once", async () => {
		const { wire, connection, seen } = wireOn(provisioned());
		connection.emit("disconnect");
		await settle();
		expect(wire.status()).toBe("disconnected");
		connection.emit("ping");
		connection.emit("reconnect");
		await settle();
		expect(wire.status()).toBe("connected");
		await wire.close();
		await wire.close();
		await settle();
		expect(wire.status()).toBe("closed");
		expect(seen).toEqual(["disconnected", "connected", "closed"]);
	});

	it("works without a status listener", async () => {
		const server = provisioned();
		const connection = server.connect();
		const wire = natsWire(connection, { consumerName }, server.clients);
		connection.emit("disconnect");
		await settle();
		await wire.close();
		expect(wire.status()).toBe("closed");
	});

	it("reads a key as absent once it holds an empty value", async () => {
		const { wire } = wireOn(provisioned());
		await wire.kvPut(BUCKETS.registry, "member.a", encoder.encode("x"));
		expect(await wire.kvGet(BUCKETS.registry, "member.a")).toEqual(
			encoder.encode("x"),
		);
		await wire.kvPut(BUCKETS.registry, "member.a", new Uint8Array());
		expect(await wire.kvGet(BUCKETS.registry, "member.a")).toBeUndefined();
		expect(await wire.kvGet(BUCKETS.registry, "member.b")).toBeUndefined();
	});

	it("lists the latest value per key, by prefix, and caps the read", async () => {
		const { wire } = wireOn(provisioned());
		expect(await wire.kvEntries(BUCKETS.registry, "", 10)).toEqual({
			entries: [],
			capped: false,
		});
		for (const key of ["member.a", "member.b", "member.c", "fleet.f"])
			await wire.kvPut(BUCKETS.registry, key, encoder.encode(key));
		await wire.kvPut(BUCKETS.registry, "member.a", encoder.encode("again"));
		await wire.kvPut(BUCKETS.registry, "member.c", new Uint8Array());
		const members = await wire.kvEntries(BUCKETS.registry, "member.", 10);
		expect(members.capped).toBe(false);
		expect(
			members.entries.map((entry) => [entry.key, decoder.decode(entry.value)]),
		).toEqual([
			["member.b", "member.b"],
			["member.a", "again"],
		]);
		const capped = await wire.kvEntries(BUCKETS.registry, "", 2);
		expect(capped.capped).toBe(true);
		expect(capped.entries.length).toBeLessThanOrEqual(2);
	});

	it("creates a key once, and lets it be created again after its TTL", async () => {
		const server = provisioned();
		const { wire } = wireOn(server);
		const one = new Uint8Array([1]);
		expect(await wire.kvCreate(BUCKETS.replay, "s.id", one, 1_500)).toBe(true);
		expect(await wire.kvCreate(BUCKETS.replay, "s.id", one, 1_500)).toBe(false);
		server.advance(2_001);
		expect(await wire.kvCreate(BUCKETS.replay, "s.id", one, 1)).toBe(true);
	});

	it("passes on a refusal that is not a create conflict", async () => {
		const server = createFakeServer();
		const { wire } = wireOn(server);
		await expect(
			wire.kvCreate(BUCKETS.replay, "s.id", new Uint8Array([1]), 1_000),
		).rejects.toThrow(/no responders/u);
		await expect(
			wire.streamPublish(STREAMS.offers, "fleet.offer.f", new Uint8Array()),
		).rejects.toThrow(/no responders/u);
	});

	it("reads the last message on a subject, and deletes it", async () => {
		const { wire } = wireOn(provisioned());
		expect(
			await wire.streamPublish(
				STREAMS.claims,
				"fleet.claim.f.d",
				encoder.encode("1"),
			),
		).toBe("stored");
		expect(
			await wire.streamPublish(
				STREAMS.claims,
				"fleet.claim.f.d",
				encoder.encode("2"),
			),
		).toBe("subject-full");
		const last = await wire.streamLast(STREAMS.claims, "fleet.claim.f.d");
		expect(last?.data).toEqual(encoder.encode("1"));
		await wire.streamDelete(STREAMS.claims, last?.sequence ?? 0);
		expect(
			await wire.streamLast(STREAMS.claims, "fleet.claim.f.d"),
		).toBeUndefined();
	});

	it("reads a stream in order up to its end", async () => {
		const { wire } = wireOn(provisioned());
		expect(await wire.streamRead(STREAMS.audit, "fleet.audit.entry")).toEqual(
			[],
		);
		for (const n of ["1", "2", "3"])
			await wire.streamPublish(
				STREAMS.audit,
				"fleet.audit.entry",
				encoder.encode(n),
			);
		await wire.streamPublish(
			STREAMS.audit,
			"fleet.audit.trust",
			encoder.encode("t"),
		);
		const read = await wire.streamRead(STREAMS.audit, "fleet.audit.entry");
		expect(read.map((message) => decoder.decode(message.data))).toEqual([
			"1",
			"2",
			"3",
		]);
	});

	it("stops a consumer that is stopped before it started", async () => {
		const { wire } = wireOn(provisioned());
		const seen: number[] = [];
		const subscription = wire.consume(
			STREAMS.offers,
			"fleet.offer.>",
			"start",
			async (message) => {
				seen.push(message.sequence);
			},
		);
		await subscription.stop();
		await wire.streamPublish(STREAMS.offers, "fleet.offer.f", new Uint8Array());
		await settle();
		expect(seen).toEqual([]);
	});

	it("delivers core messages to a subscription until it stops", async () => {
		const server = provisioned();
		const { wire } = wireOn(server);
		const seen: string[] = [];
		const subscription = wire.subscribe("fleet.relay.m.>", async (subject) => {
			seen.push(subject);
		});
		await wire.publish("fleet.relay.m.s1", new Uint8Array([1]));
		await settle();
		await subscription.stop();
		await wire.publish("fleet.relay.m.s2", new Uint8Array([2]));
		await settle();
		expect(seen).toEqual(["fleet.relay.m.s1"]);
	});
});
