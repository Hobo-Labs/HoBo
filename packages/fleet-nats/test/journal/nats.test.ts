/**
 * The NATS transport of the journal against a fake JetStream context: the
 * whole store passes `runJournalConformance` through it, and each JetStream
 * answer it handles (stream missing, no message, wrong last sequence, an
 * empty fetch) maps as `nats.ts` says.
 */

import { type AddressInfo, createServer } from "node:net";
import { OptimisticSequenceConflictError } from "@hobo/core";
import { runJournalConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { topologySpecs } from "../../src/bus/topology.js";
import { createJournalEventStore } from "../../src/journal/index.js";
import {
	connectJournalTransport,
	journalConnectionOptions,
	journalTransportOn,
} from "../../src/journal/nats.js";
import { openJournalStore } from "../../src/journal/store.js";
import { JournalWrongLastSequence } from "../../src/journal/transport.js";
import { createFakeJournalStream } from "./fake-jetstream.js";
import {
	apiError,
	createFakeJetStream,
	createFakeJetStreamState,
} from "./fake-jetstream-client.js";

const options = {
	expectedSeq: 0,
	actor: { kind: "service" as const, id: "fleet-journal-nats" },
	tenant: "t1",
};

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

const fresh = () => {
	const stream = createFakeJournalStream();
	const state = createFakeJetStreamState();
	const jet = createFakeJetStream(stream, state);
	return { stream, state, jet };
};

describe("journal store over the NATS transport and a fake JetStream context", () => {
	runJournalConformance(async () => {
		const { jet } = fresh();
		return openJournalStore(await journalTransportOn(jet));
	});
});

describe("FLEET_JOURNAL", () => {
	it("is created when missing, with the topology's settings", async () => {
		const { jet, state } = fresh();
		await journalTransportOn(jet);
		expect(state.added).toEqual([
			{
				name: "FLEET_JOURNAL",
				subjects: ["fleet.journal.>"],
				maxAge: 0,
				replicas: 1,
				denyDelete: true,
				denyPurge: true,
			},
		]);
	});

	it("is used as provisioned when it exists", async () => {
		const stream = createFakeJournalStream();
		const state = createFakeJetStreamState({
			created: true,
			subjects: ["fleet.journal.>"],
		});
		await journalTransportOn(createFakeJetStream(stream, state));
		expect(state.added).toEqual([]);
	});

	it("is used as provisionTopology creates it", async () => {
		const provisioned = topologySpecs(3).find(
			(spec) => spec.name === "FLEET_JOURNAL",
		);
		const state = createFakeJetStreamState({
			created: true,
			subjects: [...(provisioned?.subjects ?? [])],
		});
		await journalTransportOn(
			createFakeJetStream(createFakeJournalStream(), state),
		);
		expect(state.added).toEqual([]);
	});

	it("is refused when it exists without the journal subjects", async () => {
		const state = createFakeJetStreamState({
			created: true,
			subjects: ["fleet.other.>"],
		});
		await expect(
			journalTransportOn(createFakeJetStream(createFakeJournalStream(), state)),
		).rejects.toThrow(/without the subjects fleet\.journal\.>/);
	});

	it("passes on any other error from the stream lookup", async () => {
		const state = createFakeJetStreamState({
			infoFailure: new Error("permissions violation"),
		});
		await expect(
			journalTransportOn(createFakeJetStream(createFakeJournalStream(), state)),
		).rejects.toThrow("permissions violation");
		expect(state.added).toEqual([]);
	});
});

describe("transport answers", () => {
	it("reads no last message from the no-message error and from a null answer", async () => {
		const { jet, state } = fresh();
		const transport = await journalTransportOn(jet);
		expect(await transport.last("fleet.journal.none")).toBeUndefined();
		state.nullForMissing = true;
		expect(await transport.last("fleet.journal.none")).toBeUndefined();
		state.getFailure = apiError(10059, 404, "stream not found");
		await expect(transport.last("fleet.journal.none")).rejects.toThrow(
			"stream not found",
		);
	});

	it("maps a wrong last sequence to JournalWrongLastSequence and passes other errors on", async () => {
		const { jet, state } = fresh();
		const transport = await journalTransportOn(jet);
		const data = new TextEncoder().encode("x");
		await transport.publish("fleet.journal.a", data, 0);
		await expect(
			transport.publish("fleet.journal.a", data, 0),
		).rejects.toBeInstanceOf(JournalWrongLastSequence);
		state.publishFailure = new Error("timeout");
		await expect(transport.publish("fleet.journal.a", data, 1)).rejects.toThrow(
			"timeout",
		);
	});

	it("reads with an ack-less consumer it deletes afterwards, also when the reader stops early", async () => {
		const { jet, state } = fresh();
		const transport = await journalTransportOn(jet);
		const data = new TextEncoder().encode("x");
		for (const [index, subject] of ["a", "b", "a", "a"].entries())
			await transport.publish(
				`fleet.journal.${subject}`,
				data,
				[0, 0, 1, 3][index] ?? 0,
			);
		const read = await collect(transport.messages("fleet.journal.a", 1));
		expect(read.map((message) => message.seq)).toEqual([1, 3, 4]);
		for await (const message of transport.messages("fleet.journal.>", 2)) {
			expect(message.seq).toBe(2);
			break;
		}
		expect(await collect(transport.messages("fleet.journal.none", 1))).toEqual(
			[],
		);
		expect(state.ackPolicies).toEqual(["none", "none", "none"]);
		expect(state.deletedConsumers).toEqual(["fake-1", "fake-2", "fake-3"]);
	});

	it("stops reading when a fetch comes back empty", async () => {
		const { jet, state } = fresh();
		const transport = await journalTransportOn(jet);
		await transport.publish(
			"fleet.journal.a",
			new TextEncoder().encode("x"),
			0,
		);
		state.emptyFetch = true;
		expect(await collect(transport.messages("fleet.journal.a", 1))).toEqual([]);
		expect(state.deletedConsumers).toEqual(["fake-1"]);
	});

	it("watches from a start sequence until stopped", async () => {
		const { jet } = fresh();
		const transport = await journalTransportOn(jet);
		const data = new TextEncoder().encode("x");
		await transport.publish("fleet.journal.a", data, 0);
		const seen: number[] = [];
		const watch = await transport.watch("fleet.journal.>", 2, (message) => {
			seen.push(message.seq);
		});
		await transport.publish("fleet.journal.b", data, 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await watch.stop();
		await transport.publish("fleet.journal.c", data, 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(seen).toEqual([2]);
		expect(await transport.lastSequence()).toBe(3);
		await transport.close();
	});

	it("refuses a second replica at a stale expectedSeq through the transport", async () => {
		const stream = createFakeJournalStream();
		const state = createFakeJetStreamState();
		const first = openJournalStore(
			await journalTransportOn(createFakeJetStream(stream, state)),
		);
		const second = openJournalStore(
			await journalTransportOn(createFakeJetStream(stream, state)),
		);
		await first.append("r", [{ type: "fleet.Test", data: {} }], options);
		await expect(
			second.append("r", [{ type: "fleet.Test", data: {} }], options),
		).rejects.toBeInstanceOf(OptimisticSequenceConflictError);
	});
});

describe("connecting", () => {
	it("connects the way the bus does: TLS required, HOBO_FLEET_NATS_CA trusted, the URLs checked", () => {
		const before = process.env.HOBO_FLEET_NATS_CA;
		try {
			process.env.HOBO_FLEET_NATS_CA = "/etc/hobo/fleet-ca.pem";
			const options = journalConnectionOptions({
				servers: ["tls://nats.fleet.test:4222"],
				credentials: "",
			});
			expect(options.tls).toEqual({ caFile: "/etc/hobo/fleet-ca.pem" });
			expect(options.servers).toEqual(["nats://nats.fleet.test:4222"]);
			expect(options.name).toBe("hobo-fleet-journal");
			expect(options.authenticator).toBeUndefined();
			delete process.env.HOBO_FLEET_NATS_CA;
			expect(
				journalConnectionOptions({
					servers: ["nats://nats.fleet.test:4222"],
					credentials: "",
				}).tls,
			).toEqual({});
			expect(() =>
				journalConnectionOptions({
					servers: ["http://nats.fleet.test"],
					credentials: "",
				}),
			).toThrow(/tls:\/\/ or nats:\/\//u);
		} finally {
			if (before === undefined) delete process.env.HOBO_FLEET_NATS_CA;
			else process.env.HOBO_FLEET_NATS_CA = before;
		}
	});

	it("needs at least one server", async () => {
		await expect(
			createJournalEventStore({ servers: [], credentials: "" }),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("fails when nothing answers at the server address", async () => {
		const port = await new Promise<number>((resolve, reject) => {
			const server = createServer();
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
				const { port: found } = server.address() as AddressInfo;
				server.close(() => resolve(found));
			});
		});
		await expect(
			connectJournalTransport({
				servers: [`nats://127.0.0.1:${port}`],
				credentials: "",
			}),
		).rejects.toThrow();
	}, 20_000);
});

describe("transport failures it absorbs", () => {
	it("still ends a read when deleting its consumer fails", async () => {
		const { jet } = fresh();
		const transport = await journalTransportOn({
			...jet,
			consumers: {
				add: jet.consumers.add,
				async delete() {
					throw new Error("consumer already gone");
				},
			},
		});
		await transport.publish(
			"fleet.journal.a",
			new TextEncoder().encode("x"),
			0,
		);
		const read = await collect(transport.messages("fleet.journal.a", 1));
		expect(read.map((message) => message.seq)).toEqual([1]);
	});

	it("stops a watch whose message stream failed", async () => {
		const { jet } = fresh();
		const transport = await journalTransportOn({
			...jet,
			async consumer(stream, nameOrOrdered) {
				const real = await jet.consumer(stream, nameOrOrdered);
				return {
					fetch: real.fetch,
					async consume() {
						const failing = (async function* () {
							yield* [];
							throw new Error("consumer deleted");
						})();
						return Object.assign(failing, { async close() {} });
					},
				};
			},
		});
		const seen: number[] = [];
		const watch = await transport.watch("fleet.journal.>", 1, (message) => {
			seen.push(message.seq);
		});
		await watch.stop();
		expect(seen).toEqual([]);
	});
});
