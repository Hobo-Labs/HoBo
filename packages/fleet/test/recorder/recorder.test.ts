// O30 (recorder half): bus envelopes into fleet-work-* and fleet-session-*
// events, idempotently and only when verified; usage emitted once per fact;
// work status, logs and reliability answered from the record.
import { describe, expect, it } from "vitest";
import { ReceiptStatus } from "../../src/_generated/fleet_pb.js";
import { createRecorder } from "../../src/recorder/index.js";
import {
	allEvents,
	appendAs,
	claim,
	DIGEST,
	device,
	FLEET,
	fleetRecord,
	logChunk,
	offer,
	order,
	publishFleet,
	publishMember,
	Role,
	receipt,
	sessionClose,
	settle,
	submissionEnvelope,
	TENANT,
	type World,
	world,
} from "./fixtures.js";

function recorderOf(at: World) {
	return createRecorder({
		tenant: TENANT,
		store: at.store,
		bus: at.bus,
		metering: at.metering,
		now: at.clock,
		log: at.log,
	});
}

async function scene() {
	const at = await world();
	const dispatcher = await device([Role.DISPATCHER], "disp");
	const executor = await device([Role.EXECUTOR], "exec");
	await publishMember(at, dispatcher.record);
	await publishMember(at, executor.record);
	await publishFleet(at, fleetRecord());
	return { at, dispatcher, executor };
}

const types = async (at: World) =>
	(await allEvents(at.store)).map((event) => event.type);

describe("createRecorder", () => {
	it("records offers, claims, orders and receipts as fleet-work events with their bus position", async () => {
		const { at, dispatcher, executor } = await scene();
		const recorder = recorderOf(at);
		recorder.start();
		await at.bus.offers.publish(await offer(dispatcher), FLEET);
		await at.bus.claims.claim(await claim(executor, dispatcher), FLEET, DIGEST);
		await at.bus.orders.deliver(
			await order(dispatcher, executor),
			executor.keys.memberId,
		);
		await at.bus.events.publish(
			await receipt(executor, ReceiptStatus.STARTED),
			executor.keys.memberId,
			"receipt",
		);
		await at.bus.events.publish(
			await receipt(executor, ReceiptStatus.SUCCEEDED, {
				at: Date.parse("2026-11-13T12:01:00.000Z"),
				sandboxSeconds: 57,
			}),
			executor.keys.memberId,
			"receipt",
		);
		await settle(at.store);
		const events = await allEvents(at.store);
		expect(events.map((event) => event.type)).toEqual([
			"fleet.WorkOffered",
			"fleet.WorkClaimed",
			"fleet.WorkOrdered",
			"fleet.WorkStarted",
			"fleet.WorkSucceeded",
		]);
		for (const event of events) {
			expect(event.streamId).toBe(`fleet-work-${DIGEST}`);
			expect(event.meta?.busStream).toEqual(expect.any(String));
			expect(event.meta?.busSequence).toBeGreaterThan(0);
		}
		// The sealed secret is never journalled (§11.3 rule 11).
		expect(JSON.stringify(events)).not.toContain("secret-material");
		await recorder.stop();
	});

	it("replaying the bus twice appends nothing twice, and a restart resumes after the highest recorded sequence", async () => {
		const { at, dispatcher, executor } = await scene();
		const envelopes = {
			offer: await offer(dispatcher),
			claim: await claim(executor, dispatcher),
			order: await order(dispatcher, executor),
			done: await receipt(executor, ReceiptStatus.SUCCEEDED, {
				sandboxSeconds: 30,
			}),
		};
		const publishAll = async () => {
			await at.bus.offers.publish(envelopes.offer, FLEET);
			await at.bus.orders.deliver(envelopes.order, executor.keys.memberId);
			await at.bus.events.publish(
				envelopes.done,
				executor.keys.memberId,
				"receipt",
			);
		};
		await at.bus.claims.claim(envelopes.claim, FLEET, DIGEST);
		await publishAll();
		const first = recorderOf(at);
		first.start();
		await settle(at.store);
		const once = await types(at);
		expect(once).toHaveLength(4);

		// The same facts arrive again on the bus: nothing new is recorded.
		await publishAll();
		await settle(at.store);
		expect(await types(at)).toEqual(once);
		await first.stop();

		// A second recorder on the same store resumes after what is recorded.
		const second = recorderOf(at);
		second.start();
		await settle(at.store);
		expect(await types(at)).toEqual(once);
		await at.bus.events.publish(
			await receipt(executor, ReceiptStatus.STARTED, {
				orderId: "bb".repeat(16),
			}),
			executor.keys.memberId,
			"receipt",
		);
		await settle(at.store);
		expect(await types(at)).toEqual([...once, "fleet.WorkStarted"]);
		// One sandbox usage event for the one receipt that carried seconds.
		expect(
			at.usage.filter((event) => event.eventType === "fleet.work.sandbox"),
		).toHaveLength(1);
		await second.stop();
	});

	it("counts an unverifiable envelope and never records it", async () => {
		const { at, dispatcher, executor } = await scene();
		const stranger = await device([Role.EXECUTOR], "stranger"); // not in the registry
		const recorder = recorderOf(at);
		recorder.start();
		// An executor is not a dispatcher: its offer is refused.
		await at.bus.offers.publish(await offer(executor), FLEET);
		// An unknown signer.
		await at.bus.events.publish(
			await receipt(stranger, ReceiptStatus.STARTED),
			stranger.keys.memberId,
			"receipt",
		);
		// A tampered payload.
		const tampered = await receipt(executor, ReceiptStatus.SUCCEEDED);
		const bytes = tampered.payload.slice();
		bytes.set([(bytes.at(-1) ?? 0) ^ 1], bytes.length - 1);
		tampered.payload = bytes;
		await at.bus.events.publish(tampered, executor.keys.memberId, "receipt");
		// Signed by the dispatcher, published under the executor's subject.
		await at.bus.events.publish(
			await receipt(dispatcher, ReceiptStatus.STARTED),
			executor.keys.memberId,
			"receipt",
		);
		await settle(at.store);
		expect(await allEvents(at.store)).toEqual([]);
		const refusals = at.logs.filter(
			(line) => line.fields.recorder === "unverifiable",
		);
		expect(refusals.map((line) => line.fields.reason).sort()).toEqual([
			"not-dispatcher",
			"signature",
			"signer-mismatch",
			"signer-unknown",
		]);
		expect(Math.max(...refusals.map((line) => Number(line.fields.count)))).toBe(
			4,
		);
		expect(at.usage).toEqual([]);
		await recorder.stop();
	});

	it("emits fleet.work.sandbox once per receipt with sandbox seconds", async () => {
		const { at, dispatcher, executor } = await scene();
		const recorder = recorderOf(at);
		recorder.start();
		await at.bus.orders.deliver(
			await order(dispatcher, executor),
			executor.keys.memberId,
		);
		const done = await receipt(executor, ReceiptStatus.SUCCEEDED, {
			sandboxSeconds: 42,
		});
		await at.bus.events.publish(
			await receipt(executor, ReceiptStatus.STARTED),
			executor.keys.memberId,
			"receipt",
		);
		await at.bus.events.publish(done, executor.keys.memberId, "receipt");
		await at.bus.events.publish(done, executor.keys.memberId, "receipt");
		await settle(at.store);
		const sandbox = at.usage.filter(
			(event) => event.eventType === "fleet.work.sandbox",
		);
		expect(sandbox).toHaveLength(1);
		expect(sandbox[0]).toMatchObject({
			tenantId: "acme",
			quantity: 42,
			unit: "second",
			metadata: { tier: "S1_CONTAINER", memberId: executor.keys.memberId },
		});
		await recorder.stop();
	});

	it("emits transport usage once per session, from the acceptor's close, cross-checked against the initiator's", async () => {
		const { at, dispatcher, executor } = await scene();
		await appendAs(at.store, "fleet-session-s1", [
			{
				type: "fleet.SessionGranted",
				data: {
					subject: "fleet-session-s1",
					subjectSequence: 0,
					sessionId: "s1",
					initiator: dispatcher.keys.memberId,
					acceptor: executor.keys.memberId,
				},
			},
		]);
		const recorder = recorderOf(at);
		recorder.start();
		const initiatorClose = await sessionClose(
			dispatcher,
			"s1",
			"bus-relay",
			100,
			900,
		);
		const acceptorClose = await sessionClose(
			executor,
			"s1",
			"bus-relay",
			900,
			100,
		);
		await at.bus.events.publish(
			initiatorClose,
			dispatcher.keys.memberId,
			"session-close",
		);
		await settle(at.store);
		expect(at.usage).toEqual([]); // the initiator's fact alone bills nothing
		await at.bus.events.publish(
			acceptorClose,
			executor.keys.memberId,
			"session-close",
		);
		await at.bus.events.publish(
			acceptorClose,
			executor.keys.memberId,
			"session-close",
		);
		// A direct session with no grant on record bills its first close.
		await at.bus.events.publish(
			await sessionClose(executor, "s2", "p2p", 10, 20),
			executor.keys.memberId,
			"session-close",
		);
		await settle(at.store);
		expect(
			(await allEvents(at.store)).filter(
				(event) => event.type === "fleet.SessionClosed",
			),
		).toHaveLength(3);
		const relay = at.usage.filter(
			(event) => event.eventType === "fleet.transport.relay",
		);
		expect(relay).toHaveLength(1);
		expect(relay[0]).toMatchObject({
			quantity: 1000,
			unit: "byte",
			resource: "s1",
			metadata: { crossChecked: true, memberId: executor.keys.memberId },
		});
		const direct = at.usage.filter(
			(event) => event.eventType === "fleet.transport.direct",
		);
		expect(direct).toHaveLength(1);
		expect(direct[0]).toMatchObject({ quantity: 30, resource: "s2" });
		await recorder.stop();
	});

	it("answers work status by submission id and keeps it across a restart", async () => {
		const { at, dispatcher, executor } = await scene();
		await appendAs(at.store, `fleet-work-${DIGEST}`, [
			{
				type: "fleet.WorkSubmitted",
				data: {
					subject: `fleet-work-${DIGEST}`,
					subjectSequence: 0,
					submissionId: "sub-1",
					workDigest: DIGEST,
					fleet: FLEET,
				},
			},
		]);
		const recorder = recorderOf(at);
		recorder.start();
		const waiting = await recorder.workStatus("sub-1");
		expect(waiting.ok && waiting.value.workDigest).toBe(DIGEST);
		expect(waiting.ok && waiting.value.status).toBe(ReceiptStatus.UNSPECIFIED);
		expect((await recorder.workStatus("nope")).ok).toBe(false);

		await at.bus.claims.claim(await claim(executor, dispatcher), FLEET, DIGEST);
		await at.bus.events.publish(
			await receipt(executor, ReceiptStatus.SUCCEEDED),
			executor.keys.memberId,
			"receipt",
		);
		await settle(at.store);
		const done = await recorder.workStatus("sub-1");
		expect(done.ok).toBe(true);
		if (!done.ok) return;
		expect(done.value).toMatchObject({
			submissionId: "sub-1",
			workDigest: DIGEST,
			memberId: executor.keys.memberId,
			status: ReceiptStatus.SUCCEEDED,
			outputDigest: "sha256:00ff",
		});
		await recorder.stop();

		const again = recorderOf(at);
		const after = await again.workStatus("sub-1");
		expect(after.ok && after.value.status).toBe(ReceiptStatus.SUCCEEDED);
	});

	it("maps a submission carried inside an authority-signed offer", async () => {
		const { at, dispatcher } = await scene();
		const recorder = recorderOf(at);
		recorder.start();
		await at.bus.offers.publish(
			await offer(dispatcher, {
				submission: await submissionEnvelope(at, "sub-9"),
			}),
			FLEET,
		);
		await settle(at.store);
		const status = await recorder.workStatus("sub-9");
		expect(status.ok && status.value.workDigest).toBe(DIGEST);
		await recorder.stop();
	});

	it("answers work logs from the executor's verified chunks, in order", async () => {
		const { at, dispatcher, executor } = await scene();
		await appendAs(at.store, `fleet-work-${DIGEST}`, [
			{
				type: "fleet.WorkSubmitted",
				data: { submissionId: "sub-1", workDigest: DIGEST, fleet: FLEET },
			},
		]);
		const recorder = recorderOf(at);
		recorder.start();
		await at.bus.orders.deliver(
			await order(dispatcher, executor),
			executor.keys.memberId,
		);
		await at.bus.events.publish(
			await logChunk(executor, 1, "world", true),
			executor.keys.memberId,
			"log",
		);
		await at.bus.events.publish(
			await logChunk(executor, 0, "hello "),
			executor.keys.memberId,
			"log",
		);
		// A chunk for this order signed by someone else is not the executor's log.
		await at.bus.events.publish(
			await logChunk(dispatcher, 2, "forged"),
			dispatcher.keys.memberId,
			"log",
		);
		await settle(at.store);
		const logs = await recorder.workLogs("sub-1");
		expect(logs.ok).toBe(true);
		if (!logs.ok) return;
		expect(
			logs.value.chunks.map((chunk) => new TextDecoder().decode(chunk.data)),
		).toEqual(["hello ", "world"]);
		expect(logs.value.complete).toBe(true);
		expect((await recorder.workLogs("missing")).ok).toBe(false);
		await recorder.stop();
	});

	it("keeps the reliability ledger from recorded receipts and rebuilds it from the store", async () => {
		const { at, dispatcher, executor } = await scene();
		const recorder = recorderOf(at);
		recorder.start();
		await at.bus.orders.deliver(
			await order(dispatcher, executor),
			executor.keys.memberId,
		);
		await at.bus.events.publish(
			await receipt(executor, ReceiptStatus.REFUSED),
			executor.keys.memberId,
			"receipt",
		);
		await settle(at.store);
		const samples = recorder.reliability().get(executor.keys.memberId);
		expect(samples?.dropped).toBeGreaterThan(0);
		await recorder.stop();

		const rebuilt = recorderOf(at);
		await rebuilt.workStatus("warm-up"); // any read catches up from the store
		expect(rebuilt.reliability().get(executor.keys.memberId)).toEqual(samples);
	});
});
