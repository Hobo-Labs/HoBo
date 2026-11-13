// Audit verification across trust rotations (L41): each checkpoint verifies
// against the trust record in force at that checkpoint, taken from the
// journalled `fleet.TrustRotated` records that are in the chain. A checkpoint
// signed before the record-signing and witness keys rotated still verifies
// after the old keys are removed; a removed key verifies nothing signed after
// its removal; the history must be unambiguous and end at the pinned record.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	AuditCheckpointSchema,
	AuditEntrySchema,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
} from "../../src/_generated/fleet_pb.js";
import {
	checkpointPayload,
	entryHash,
	GENESIS_HASH,
} from "../../src/audit/hash.js";
import { createAuditChain, verifyAuditChain } from "../../src/audit/index.js";
import { verifyChainAcrossTrust } from "../../src/audit/verify.js";
import { AUDIT_CHECKPOINT_CONTEXT } from "../../src/contexts.js";
import { signEnvelope } from "../../src/keys/index.js";
import type { FleetEventStore, Signer } from "../../src/ports.js";
import { createMemoryEventStore } from "../../src/testing/plumbing/index.js";
import {
	memoryAuditLog,
	type TrustKeys,
	trustKeys,
	witnessedOf,
} from "./fixtures.js";

const actor = { kind: "service" as const, id: "test" };
const old = trustKeys(1);
const fresh = trustKeys(2);

function record(
	sequence: number,
	authority: readonly TrustKeys[],
	witness: readonly TrustKeys[],
	tenant = "acme",
): TrustRecord {
	return create(TrustRecordSchema, {
		tenant,
		sequence,
		authorityKeys: authority.map((keys) => keys.authority.ref),
		witnessKeys: witness.map((keys) => keys.witness.ref),
		authorityIncarnation: 1,
		issuer: "https://authority.test",
		issuedAt: "2026-01-01T00:00:00.000Z",
	});
}

const T1 = record(1, [old], [old]);
const T2 = record(2, [old, fresh], [old, fresh]);
const T3 = record(3, [fresh], [fresh]);

async function append(
	store: FleetEventStore,
	streamId: string,
	events: readonly Readonly<{ type: string; data?: object }>[],
): Promise<void> {
	let head = 0;
	for await (const event of store.read(streamId)) head = event.seq;
	await store.append(streamId, [...events], {
		expectedSeq: head,
		actor,
		tenant: "acme",
	});
}

const rotated = (trust: TrustRecord) => ({
	type: "fleet.TrustRotated",
	data: {
		record: Buffer.from(toBinary(TrustRecordSchema, trust)).toString("base64"),
		sequence: trust.sequence,
	},
});

/**
 * A chain under T1 (genesis, not journalled), then T2 (both keys) journalled,
 * the switch to the new keys, then T3 (new keys only) journalled. One
 * checkpoint per phase, each co-signed by the witness key active then.
 */
async function rotatedChain(duplicate?: TrustRecord) {
	let clock = 1_000_000;
	const store = createMemoryEventStore();
	const log = memoryAuditLog();
	const witnessOf = new Map<number, Signer>();
	const phase = async (
		signer: Signer,
		witness: Signer,
		before: () => Promise<void>,
	) => {
		await before();
		const chain = createAuditChain({
			store,
			log,
			signer,
			incarnation: 1,
			now: () => clock,
		});
		await chain.tick();
		clock += 60_000;
		await append(store, `fleet-work-${clock}`, [{ type: "fleet.WorkOffered" }]);
		await chain.tick();
		witnessOf.set(log.checkpoints.length, witness);
	};
	await phase(old.authority.signer, old.witness.signer, () =>
		append(store, "fleet-work-a", [{ type: "fleet.WorkOffered" }]),
	);
	await phase(old.authority.signer, old.witness.signer, () =>
		append(
			store,
			"fleet-trust",
			duplicate === undefined
				? [rotated(T2)]
				: [rotated(T2), rotated(duplicate)],
		),
	);
	await phase(fresh.authority.signer, fresh.witness.signer, () =>
		append(store, "fleet-work-b", [{ type: "fleet.WorkClaimed" }]),
	);
	await phase(fresh.authority.signer, fresh.witness.signer, () =>
		append(store, "fleet-trust", [rotated(T3)]),
	);
	const checkpoints: WitnessedEnvelope[] = [];
	for (const [index, checkpoint] of log.checkpoints.entries()) {
		let witness: Signer | undefined;
		for (const [upTo, signer] of witnessOf)
			if (index < upTo && witness === undefined) witness = signer;
		checkpoints.push(
			witnessedOf(
				checkpoint,
				await signEnvelope(
					witness ?? fresh.witness.signer,
					AUDIT_CHECKPOINT_CONTEXT,
					checkpoint.payload,
				),
			),
		);
	}
	const journal: EventEnvelope[] = [];
	for await (const item of store.readAll()) journal.push(item.event);
	return {
		entries: log.all.map((entry) => create(AuditEntrySchema, entry)),
		checkpoints,
		journal,
	};
}

describe("verifyChainAcrossTrust", () => {
	it("verifies every checkpoint against the record in force at it, after the old keys are removed", async () => {
		const { entries, checkpoints, journal } = await rotatedChain();
		expect(checkpoints.length).toBeGreaterThanOrEqual(4);
		// The pinned record alone no longer verifies the early checkpoints.
		const single = verifyAuditChain(entries, checkpoints, T3);
		expect(single.ok).toBe(false);
		if (!single.ok)
			expect(single.error.detail?.rule).toBe("checkpoint-signature");

		const result = verifyChainAcrossTrust(entries, checkpoints, T3, journal);
		expect(result).toEqual({
			ok: true,
			value: {
				entries: entries.length,
				finalThrough: Math.max(
					...checkpoints.map((c) => decodeCheckpoint(c).sequence),
				),
			},
		});
	});

	it("keeps the single-record call: with no rotations it is verifyAuditChain", async () => {
		const { entries, checkpoints } = await rotatedChain();
		const early = checkpoints.slice(0, 2);
		const covered = entries.slice(0, decodeCheckpoint(early[1]).sequence);
		expect(verifyChainAcrossTrust(covered, early, T1, [])).toEqual(
			verifyAuditChain(covered, early, T1),
		);
		expect(verifyAuditChain(covered, early, T1).ok).toBe(true);
	});

	it("refuses a checkpoint signed with a removed key after its removal", async () => {
		const { entries, checkpoints, journal } = await rotatedChain();
		const last = entries.length;
		let hash = GENESIS_HASH;
		for (const entry of entries) hash = entryHash(hash, entry);
		const forged = create(AuditCheckpointSchema, {
			sequence: last,
			entryHash: hash,
			at: entries.at(-1)?.at ?? "",
			authorityIncarnation: 1,
		});
		const payload = checkpointPayload(forged);
		const withOldKeys = witnessedOf(
			await signEnvelope(
				old.authority.signer,
				AUDIT_CHECKPOINT_CONTEXT,
				payload,
			),
			await signEnvelope(old.witness.signer, AUDIT_CHECKPOINT_CONTEXT, payload),
		);
		const result = verifyChainAcrossTrust(
			entries,
			[...checkpoints, withOldKeys],
			T3,
			journal,
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.detail?.rule).toBe("checkpoint-signature");
	});

	it("ignores a journalled record that is not in the chain, or is beyond the pinned record", async () => {
		const { entries, checkpoints, journal } = await rotatedChain();
		const last = journal.at(-1);
		if (last === undefined) throw new Error("empty journal");
		const extra = (trust: TrustRecord, id: string): EventEnvelope => ({
			...last,
			id,
			streamId: "fleet-trust",
			type: "fleet.TrustRotated",
			data: rotated(trust).data,
		});
		// Beyond the pinned record: never in force.
		expect(
			verifyChainAcrossTrust(entries, checkpoints, T3, [
				...journal,
				extra(record(4, [old], [old]), "beyond"),
			]).ok,
		).toBe(true);
		// Journalled but never chained: no entry carries its digest.
		expect(
			verifyChainAcrossTrust(entries, checkpoints, T3, [
				...journal,
				extra(record(2, [old], [old], "acme"), "unchained"),
			]).ok,
		).toBe(true);
	});

	it("refuses an ambiguous history, or one that does not end at the pinned record", async () => {
		const { entries, checkpoints, journal } = await rotatedChain();
		const notPinned = record(3, [old], [old]);
		const result = verifyChainAcrossTrust(
			entries,
			checkpoints,
			notPinned,
			journal,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail?.rule).toBe("trust-history");

		const otherTenant = record(3, [fresh], [fresh], "other");
		const tenant = verifyChainAcrossTrust(
			entries,
			checkpoints,
			otherTenant,
			journal,
		);
		expect(tenant.ok).toBe(false);
		if (!tenant.ok) expect(tenant.error.detail?.rule).toBe("trust-history");

		// Two chained records with one sequence: which was in force is unknown.
		const twice = await rotatedChain(record(2, [old], [old]));
		const ambiguous = verifyChainAcrossTrust(
			twice.entries,
			twice.checkpoints,
			T3,
			twice.journal,
		);
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok)
			expect(ambiguous.error.detail?.rule).toBe("trust-history");
	});
});

function decodeCheckpoint(witnessed: WitnessedEnvelope | undefined) {
	return fromBinary(
		AuditCheckpointSchema,
		witnessed?.authority?.payload ?? new Uint8Array(),
	);
}
