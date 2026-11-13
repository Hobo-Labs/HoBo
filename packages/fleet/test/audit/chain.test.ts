// O13 (chain half): every journal event becomes a hash-chained audit entry,
// checkpoints are signed every 60 s or 1,000 entries, and altering, removing or
// reordering any entry fails verification (design §6.14).
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	AuditCheckpointSchema,
	type AuditEntry,
	AuditEntrySchema,
	type WitnessedEnvelope,
} from "../../src/_generated/fleet_pb.js";
import { entryHash, GENESIS_HASH, sha256Hex } from "../../src/audit/hash.js";
import { createAuditChain, verifyAuditChain } from "../../src/audit/index.js";
import { AUDIT_CHECKPOINT_CONTEXT } from "../../src/contexts.js";
import { signEnvelope, verifyEnvelope } from "../../src/keys/index.js";
import type { FleetEventStore } from "../../src/ports.js";
import { createMemoryEventStore } from "../../src/testing/plumbing/index.js";
import {
	memoryAuditLog,
	trustKeys,
	trustPayload,
	trustRecord,
	witnessedOf,
} from "./fixtures.js";

const keys = trustKeys();
const trust = trustRecord(1, keys);
const actor = { kind: "service" as const, id: "test" };

async function journal(
	store: FleetEventStore,
	streamId: string,
	events: readonly Readonly<{
		type: string;
		data?: object;
		meta?: Record<string, number | string>;
	}>[],
): Promise<void> {
	let head = 0;
	for await (const event of store.read(streamId)) head = event.seq;
	await store.append(streamId, [...events], {
		expectedSeq: head,
		actor,
		tenant: "acme",
	});
}

function setup(start = 1_000_000) {
	let clock = start;
	const store = createMemoryEventStore();
	const log = memoryAuditLog();
	const chain = createAuditChain({
		store,
		log,
		signer: keys.authority.signer,
		incarnation: 3,
		now: () => clock,
	});
	return {
		store,
		log,
		chain,
		advance(ms: number) {
			clock += ms;
		},
	};
}

async function witnessAll(
	log: ReturnType<typeof memoryAuditLog>,
): Promise<WitnessedEnvelope[]> {
	const out: WitnessedEnvelope[] = [];
	for (const checkpoint of log.checkpoints)
		out.push(
			witnessedOf(
				checkpoint,
				await signEnvelope(
					keys.witness.signer,
					AUDIT_CHECKPOINT_CONTEXT,
					checkpoint.payload,
				),
			),
		);
	return out;
}

describe("createAuditChain", () => {
	it("turns every journal event, in journal order, into one chained entry", async () => {
		const { store, log, chain } = setup();
		await journal(store, "fleet-member-dev_a", [
			{ type: "fleet.EnrollmentRequested", data: { b: 1, a: 2 } },
			{ type: "fleet.MemberActivated", data: { recordSequence: 2 } },
		]);
		await journal(store, "fleet-fleet-flt_x", [
			{ type: "fleet.FleetDefined", data: { revision: 1 } },
		]);
		await journal(store, "fleet-member-dev_b", [
			{ type: "fleet.MemberSuspended", meta: { subjectSequence: 7 } },
		]);
		await journal(store, "fleet-work-abc", [
			{ type: "fleet.WorkOffered", data: { recordSequence: 9 } },
		]);
		await journal(store, "fleet-member-dev_c", [
			{ type: "fleet.MemberActivated", data: { subjectSequence: 3 } },
		]);
		await chain.tick();

		expect(log.all.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(log.all.map((e) => e.eventType)).toEqual([
			"fleet.EnrollmentRequested",
			"fleet.MemberActivated",
			"fleet.FleetDefined",
			"fleet.MemberSuspended",
			"fleet.WorkOffered",
			"fleet.MemberActivated",
		]);
		expect(log.all.map((e) => [e.subject, e.subjectSequence])).toEqual([
			["fleet-member-dev_a", 0],
			["member.dev_a", 2],
			["fleet.flt_x", 1],
			["member.dev_b", 7],
			["fleet-work-abc", 0],
			["member.dev_c", 3],
		]);
		expect(log.all[0]?.previousHash).toBe(GENESIS_HASH);
		for (let i = 1; i < log.all.length; i += 1) {
			const previous = log.all[i - 1];
			if (previous === undefined) throw new Error("entry");
			expect(log.all[i]?.previousHash).toBe(
				entryHash(previous.previousHash, previous),
			);
		}
		// data_digest is over the canonical (key-sorted) JSON of the data.
		expect(log.all[0]?.dataDigest).toBe(
			sha256Hex('{\n  "a": 2,\n  "b": 1\n}\n'),
		);
		expect(log.all[0]?.actor).toBe("service:test");

		await chain.tick();
		expect(log.all).toHaveLength(6);
	});

	it("gives a fleet.TrustRotated entry the digest of the trust record bytes it carries", async () => {
		const { store, log, chain } = setup();
		const payload = trustPayload(trustRecord(2, keys));
		await journal(store, "fleet-trust", [
			{
				type: "fleet.TrustRotated",
				data: { record: Buffer.from(payload).toString("base64"), sequence: 2 },
			},
		]);
		await chain.tick();
		expect(log.all[0]?.dataDigest).toBe(sha256Hex(payload));
		expect([log.all[0]?.subject, log.all[0]?.subjectSequence]).toEqual([
			"trust",
			2,
		]);
	});

	it("signs a checkpoint after 60 s, over the head entry, and journals it as fleet.AuditCheckpointed", async () => {
		const { store, log, chain, advance } = setup();
		await journal(store, "fleet-work-a", [
			{ type: "fleet.WorkOffered" },
			{ type: "fleet.WorkClaimed" },
		]);
		await chain.tick();
		expect(log.checkpoints).toHaveLength(0);
		advance(59_999);
		await chain.tick();
		expect(log.checkpoints).toHaveLength(0);
		advance(1);
		await chain.tick();
		expect(log.checkpoints).toHaveLength(1);

		const signed = log.checkpoints[0];
		if (signed === undefined) throw new Error("checkpoint");
		expect(
			verifyEnvelope(signed, AUDIT_CHECKPOINT_CONTEXT, keys.authority.ref),
		).toBe(true);
		const checkpoint = fromBinary(AuditCheckpointSchema, signed.payload);
		const head = log.all[1];
		if (head === undefined) throw new Error("head");
		expect(checkpoint.sequence).toBe(2);
		expect(checkpoint.entryHash).toBe(entryHash(head.previousHash, head));
		expect(checkpoint.at).toBe(head.at);
		expect(checkpoint.authorityIncarnation).toBe(3);

		const audit = [];
		for await (const event of store.read("fleet-audit")) audit.push(event);
		expect(audit.map((e) => e.type)).toEqual(["fleet.AuditCheckpointed"]);
		expect(audit[0]?.data).toEqual({
			sequence: 2,
			entryHash: checkpoint.entryHash,
			at: checkpoint.at,
			authorityIncarnation: 3,
		});

		// The checkpoint event itself becomes the next entry; nothing else is due until 60 s pass again.
		await chain.tick();
		expect(log.all.at(-1)?.eventType).toBe("fleet.AuditCheckpointed");
		expect(log.checkpoints).toHaveLength(1);
		advance(60_000);
		await chain.tick();
		expect(log.checkpoints).toHaveLength(2);
	});

	it("checkpoints every 1,000 entries", async () => {
		const { store, log, chain } = setup();
		await journal(
			store,
			"fleet-work-many",
			Array.from({ length: 2_100 }, () => ({ type: "fleet.WorkOffered" })),
		);
		await chain.tick();
		expect(
			log.checkpoints.map(
				(c) => fromBinary(AuditCheckpointSchema, c.payload).sequence,
			),
		).toEqual([1_000, 2_000]);
	});

	it("resumes after a restart without repeating or skipping an event", async () => {
		const first = setup();
		await journal(first.store, "fleet-work-a", [{ type: "fleet.WorkOffered" }]);
		await first.chain.tick();
		first.advance(60_000);
		await first.chain.tick();
		await journal(first.store, "fleet-work-a", [{ type: "fleet.WorkClaimed" }]);
		await first.chain.tick();
		const before = first.log.all.length;

		const second = createAuditChain({
			store: first.store,
			log: first.log,
			signer: keys.authority.signer,
			incarnation: 3,
			now: () => 2_000_000,
		});
		await journal(first.store, "fleet-work-b", [{ type: "fleet.WorkOffered" }]);
		await second.tick();
		expect(first.log.all).toHaveLength(before + 1);
		expect(first.log.all.at(-1)?.subject).toBe("fleet-work-b");
		expect(verifyAuditChain(first.log.all, [], trust).ok).toBe(true);
	});
});

async function chainWithCheckpoints() {
	const { store, log, chain, advance } = setup();
	for (let round = 0; round < 3; round += 1) {
		await journal(store, `fleet-work-${round}`, [
			{ type: "fleet.WorkOffered" },
			{ type: "fleet.WorkClaimed" },
		]);
		await chain.tick();
		advance(60_000);
		await chain.tick();
	}
	return {
		entries: log.all.map((e) => create(AuditEntrySchema, e)),
		checkpoints: await witnessAll(log),
		log,
	};
}

describe("verifyAuditChain", () => {
	it("accepts the untouched chain with its witnessed checkpoints", async () => {
		const { entries, checkpoints } = await chainWithCheckpoints();
		const result = verifyAuditChain(entries, checkpoints, trust);
		expect(result).toEqual({
			ok: true,
			value: { entries: entries.length, finalThrough: 8 },
		});
	});

	it("fails when any field of any entry is altered", async () => {
		const { entries, checkpoints } = await chainWithCheckpoints();
		const lastCovered = 8;
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: lastCovered - 1 }),
				fc.constantFrom(
					"eventType",
					"eventId",
					"subject",
					"actor",
					"at",
					"dataDigest",
					"subjectSequence",
				),
				async (index, field) => {
					const altered = entries.map((e) => create(AuditEntrySchema, e));
					const target = altered[index];
					if (target === undefined) throw new Error("entry");
					if (field === "subjectSequence") target.subjectSequence += 1;
					else target[field] = `${target[field]}x`;
					expect(verifyAuditChain(altered, checkpoints, trust).ok).toBe(false);
				},
			),
		);
	});

	it("fails when any entry is removed or two are swapped", async () => {
		const { entries, checkpoints } = await chainWithCheckpoints();
		for (let i = 0; i < 8; i += 1) {
			const removed = entries.filter((_, j) => j !== i);
			expect(
				verifyAuditChain(removed, checkpoints, trust).ok,
				`removed ${i + 1}`,
			).toBe(false);
			if (i + 1 < entries.length) {
				const swapped = [...entries];
				const [a, b] = [swapped[i], swapped[i + 1]];
				if (a === undefined || b === undefined) throw new Error("entry");
				swapped[i] = b;
				swapped[i + 1] = a;
				expect(
					verifyAuditChain(swapped, checkpoints, trust).ok,
					`swapped ${i + 1}`,
				).toBe(false);
			}
		}
	});

	it("fails when a rewritten chain is re-hashed but the checkpoints are not re-witnessed", async () => {
		const { entries, checkpoints } = await chainWithCheckpoints();
		const rewritten: AuditEntry[] = [];
		let previous = GENESIS_HASH;
		for (const entry of entries) {
			const next = create(AuditEntrySchema, {
				...entry,
				previousHash: previous,
			});
			if (next.sequence === 2) next.eventType = "fleet.WorkCancelled";
			rewritten.push(next);
			previous = entryHash(previous, next);
		}
		const result = verifyAuditChain(rewritten, checkpoints, trust);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail?.rule).toBe("checkpoint-hash");
	});

	it("fails a checkpoint signed only by the authority, or co-signed by an unpinned witness key", async () => {
		const { entries, log } = await chainWithCheckpoints();
		const signed = log.checkpoints[0];
		if (signed === undefined) throw new Error("checkpoint");
		const rogue = trustKeys(9);
		const onlyAuthority = witnessedOf(signed, signed);
		const rogueWitness = witnessedOf(
			signed,
			await signEnvelope(
				rogue.witness.signer,
				AUDIT_CHECKPOINT_CONTEXT,
				signed.payload,
			),
		);
		for (const bad of [onlyAuthority, rogueWitness]) {
			const result = verifyAuditChain(entries, [bad], trust);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error.detail?.rule).toBe("checkpoint-signature");
		}
	});

	it("fails a checkpoint over entries that are not there", async () => {
		const { entries, checkpoints } = await chainWithCheckpoints();
		const result = verifyAuditChain(entries.slice(0, 3), checkpoints, trust);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail?.rule).toBe("checkpoint-beyond");
	});

	it("accepts an empty chain", () => {
		expect(verifyAuditChain([], [], trust)).toEqual({
			ok: true,
			value: { entries: 0, finalThrough: 0 },
		});
		expect(toBinary(AuditEntrySchema, create(AuditEntrySchema)).length).toBe(0);
	});
});
