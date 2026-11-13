// O13 (witness half), F12, F13: the witness recomputes the chain itself,
// co-signs a checkpoint only when no entry is withheld and every registry
// change it saw has its audit entry, co-signs a proposed trust record only by
// the three rules of §6.14, logs every refusal and alarms after three
// unfinal checkpoints in a row (design §6.14).
import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AuditCheckpointSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustRecordSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	checkpointOver,
	checkpointPayload,
	sha256Hex,
} from "../../src/audit/hash.js";
import {
	createAuditChain,
	createWitness,
	verifyAuditChain,
} from "../../src/audit/index.js";
import { REGISTRY_CHANGE_SKEW_MS, witness } from "../../src/audit/witness.js";
import {
	AUDIT_CHECKPOINT_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../src/contexts.js";
import {
	acceptTrust,
	signEnvelope,
	verifyEnvelope,
} from "../../src/keys/index.js";
import type { FleetLogEvent } from "../../src/ports.js";
import { createMemoryEventStore } from "../../src/testing/plumbing/index.js";
import {
	appendCheckpointEntry,
	appendEntries,
	headOf,
	iso,
	memoryAuditLog,
	trustKeys,
	trustPayload,
	trustRecord,
	witnessedOf,
} from "./fixtures.js";

const keys = trustKeys();
const pinned = trustRecord(4, keys);
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

type Logged = Readonly<{
	event: FleetLogEvent;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

async function setup() {
	let clock = T0;
	const log = memoryAuditLog();
	const logged: Logged[] = [];
	const published: {
		cosignature: SignedEnvelope;
		of: "checkpoint" | "trust";
	}[] = [];
	let onChange:
		| ((key: string, recordSequence: number) => Promise<void>)
		| undefined;
	const w = witness({
		log,
		registryChanges(handler) {
			onChange = handler;
			return { async stop() {} };
		},
		trust: () => pinned,
		signer: keys.witness.signer,
		async publish(cosignature, of) {
			published.push({ cosignature, of });
		},
		now: () => clock,
		log2: (event, fields) => logged.push({ event, fields }),
	});
	w.start();
	await w.poll(); // the poll start() begins, on an empty log
	return {
		log,
		logged,
		published,
		witness: w,
		at(ms: number) {
			clock = T0 + ms;
		},
		async change(key: string, recordSequence: number) {
			if (onChange === undefined) throw new Error("not watching the registry");
			await onChange(key, recordSequence);
		},
		refusals: () =>
			logged.filter((l) => l.event === "hobo_fleet_witness_refused"),
		lags: () => logged.filter((l) => l.event === "hobo_fleet_witness_lag"),
		checkpoints: () =>
			published
				.filter((p) => p.of === "checkpoint")
				.map((p) => fromBinary(AuditCheckpointSchema, p.cosignature.payload)),
	};
}

describe("createWitness: checkpoints", () => {
	it("co-signs a checkpoint over the chain it recomputed, with the authority's exact payload", async () => {
		const t = await setup();
		await appendEntries(t.log, [
			{ at: iso(T0 + 1) },
			{ at: iso(T0 + 2) },
			{ at: iso(T0 + 3) },
		]);
		await appendCheckpointEntry(t.log, 3, iso(T0 + 60_000));
		await t.witness.poll();

		expect(t.published).toHaveLength(1);
		const cosig = t.published[0]?.cosignature;
		if (cosig === undefined) throw new Error("co-signature");
		expect(
			verifyEnvelope(cosig, AUDIT_CHECKPOINT_CONTEXT, keys.witness.ref),
		).toBe(true);
		const head = headOf(t.log, 3);
		expect(Buffer.from(cosig.payload)).toEqual(
			Buffer.from(checkpointPayload(checkpointOver(3, head.hash, head.at, 1))),
		);
		expect(t.refusals()).toEqual([]);
		await t.witness.stop();
	});

	it("refuses when an entry is withheld, and logs hobo_fleet_witness_refused", async () => {
		const t = await setup();
		await appendEntries(t.log, [
			{ at: iso(T0 + 1) },
			{ at: iso(T0 + 2) },
			{ at: iso(T0 + 3) },
		]);
		await appendCheckpointEntry(t.log, 3, iso(T0 + 60_000));
		t.log.hide((e) => e.sequence === 2);
		await t.witness.poll();
		await t.witness.poll();
		expect(t.published).toEqual([]);
		expect(t.refusals()).toEqual([
			{
				event: "hobo_fleet_witness_refused",
				fields: {
					of: "checkpoint",
					reason: "entries-withheld",
					entry: 4,
					at: 2,
				},
			},
		]);
	});

	it("refuses when an entry was altered after it was chained", async () => {
		const t = await setup();
		await appendEntries(t.log, [{ at: iso(T0 + 1) }, { at: iso(T0 + 2) }]);
		await appendCheckpointEntry(t.log, 2, iso(T0 + 60_000));
		const first = t.log.all[0];
		if (first === undefined) throw new Error("entry");
		first.eventType = "fleet.WorkCancelled";
		await t.witness.poll();
		expect(t.published).toEqual([]);
		expect(t.refusals().map((r) => r.fields.reason)).toEqual(["chain-broken"]);
	});

	it("refuses a checkpoint entry that names no prefix of the chain it recomputed", async () => {
		const t = await setup();
		await appendEntries(t.log, [{ at: iso(T0 + 1) }]);
		await appendEntries(t.log, [
			{
				type: "fleet.AuditCheckpointed",
				subject: "fleet-audit",
				at: iso(T0 + 60_000),
				digest: sha256Hex("forged"),
			},
		]);
		await t.witness.poll();
		expect(t.published).toEqual([]);
		expect(t.refusals().map((r) => r.fields.reason)).toEqual([
			"checkpoint-unknown",
		]);
	});

	it("refuses while a registry change has no audit entry of that subject and subject_sequence, then co-signs once it has", async () => {
		const t = await setup();
		await appendEntries(t.log, [
			{ at: iso(T0 + 1), subject: "member.dev_a", subjectSequence: 3 },
		]);
		await t.change("member.dev_a", 3);
		await t.change("member.dev_a", 4);
		// An entry for another key, and one for this key at another sequence, do not match.
		await appendEntries(t.log, [
			{ at: iso(T0 + 2), subject: "member.dev_b", subjectSequence: 4 },
			{ at: iso(T0 + 3), subject: "member.dev_a", subjectSequence: 5 },
		]);
		await appendCheckpointEntry(t.log, 3, iso(T0 + 60_000));
		await t.witness.poll();
		expect(t.published).toEqual([]);
		expect(t.refusals()).toEqual([
			{
				event: "hobo_fleet_witness_refused",
				fields: {
					of: "checkpoint",
					reason: "registry-change-unrecorded",
					entry: 4,
					key: "member.dev_a",
					record_sequence: 4,
					checkpoint: 3,
				},
			},
		]);

		await appendEntries(t.log, [
			{ at: iso(T0 + 61_000), subject: "member.dev_a", subjectSequence: 4 },
		]);
		await appendCheckpointEntry(t.log, 5, iso(T0 + 120_000));
		await t.witness.poll();
		expect(t.checkpoints().map((c) => c.sequence)).toEqual([5]);
	});

	it("does not hold a checkpoint journaled just after a change (the change is due at the next one)", async () => {
		const t = await setup();
		await appendEntries(t.log, [{ at: iso(T0 + 1) }]);
		t.at(60_000 - REGISTRY_CHANGE_SKEW_MS + 1);
		await t.change("fleet.flt_x", 2);
		await appendCheckpointEntry(t.log, 1, iso(T0 + 60_000));
		await t.witness.poll();
		expect(t.checkpoints().map((c) => c.sequence)).toEqual([1]);

		await appendCheckpointEntry(t.log, 2, iso(T0 + 120_000));
		await t.witness.poll();
		expect(t.checkpoints().map((c) => c.sequence)).toEqual([1]);
		expect(t.refusals().map((r) => r.fields.reason)).toEqual([
			"registry-change-unrecorded",
		]);
	});

	it("co-signs through a run of re-signed records (same sequence, new not_after) with no audit entries", async () => {
		const t = await setup();
		await appendEntries(t.log, [
			{ at: iso(T0 + 1), subject: "member.dev_a", subjectSequence: 7 },
		]);
		await t.change("member.dev_a", 7);
		for (let i = 1; i <= 5; i += 1) {
			t.at(i * 600_000);
			// A re-sign every 10 minutes keeps the record sequence: not a change.
			await t.change("member.dev_a", 7);
			await appendCheckpointEntry(
				t.log,
				t.log.all.length,
				iso(T0 + i * 600_000 + 60_000),
			);
			await t.witness.poll();
		}
		expect(t.checkpoints()).toHaveLength(5);
		expect(t.refusals()).toEqual([]);
	});

	it("logs hobo_fleet_witness_lag at the third refused checkpoint in a row, and resets after a co-signature", async () => {
		const t = await setup();
		await appendEntries(t.log, [{ at: iso(T0 + 1) }]);
		await t.change("member.dev_z", 1);
		for (let i = 1; i <= 2; i += 1) {
			await appendCheckpointEntry(
				t.log,
				t.log.all.length,
				iso(T0 + i * 60_000),
			);
			await t.witness.poll();
		}
		expect(t.refusals()).toHaveLength(2);
		expect(t.lags()).toEqual([]);
		await appendCheckpointEntry(t.log, t.log.all.length, iso(T0 + 180_000));
		await t.witness.poll();
		expect(t.lags()).toEqual([
			{
				event: "hobo_fleet_witness_lag",
				fields: { consecutive: 3, through: 4 },
			},
		]);

		await appendEntries(t.log, [
			{ at: iso(T0 + 181_000), subject: "member.dev_z", subjectSequence: 1 },
		]);
		await appendCheckpointEntry(t.log, t.log.all.length, iso(T0 + 240_000));
		await t.witness.poll();
		expect(t.checkpoints()).toHaveLength(1);
		await appendEntries(t.log, [{ at: iso(T0 + 241_000) }]);
		await t.change("member.dev_y", 1);
		for (let i = 5; i <= 6; i += 1) {
			await appendCheckpointEntry(
				t.log,
				t.log.all.length,
				iso(T0 + i * 60_000),
			);
			await t.witness.poll();
		}
		expect(t.lags()).toHaveLength(1);
	});
});

describe("createWitness: trust records", () => {
	async function propose(
		t: Awaited<ReturnType<typeof setup>>,
		sequence: number,
		signer = keys.authority.signer,
		rotated = true,
	) {
		const payload = trustPayload(trustRecord(sequence, trustKeys(sequence)));
		if (rotated)
			await appendEntries(t.log, [
				{
					type: "fleet.TrustRotated",
					subject: "trust",
					subjectSequence: sequence,
					at: iso(T0 + 1),
					digest: sha256Hex(payload),
				},
			]);
		const envelope = await signEnvelope(signer, TRUST_RECORD_CONTEXT, payload);
		await t.log.proposeTrust(envelope);
		await t.witness.poll();
		return envelope;
	}

	it("co-signs the next sequence, signed by a pinned authority key, with its fleet.TrustRotated entry", async () => {
		const t = await setup();
		const proposal = await propose(t, 5);
		const trust = t.published.filter((p) => p.of === "trust");
		expect(trust).toHaveLength(1);
		const cosig = trust[0]?.cosignature;
		if (cosig === undefined) throw new Error("co-signature");
		const accepted = acceptTrust(pinned, witnessedOf(proposal, cosig));
		expect(accepted.ok).toBe(true);
		expect(fromBinary(TrustRecordSchema, cosig.payload).sequence).toBe(5);
		expect(t.refusals()).toEqual([]);
	});

	it("refuses a skipped sequence", async () => {
		const t = await setup();
		await propose(t, 6);
		expect(t.published).toEqual([]);
		expect(t.refusals().map((r) => r.fields)).toEqual([
			{ of: "trust", reason: "sequence", sequence: 6, pinned: 4 },
		]);
	});

	it("refuses a record signed by an unpinned key", async () => {
		const t = await setup();
		await propose(t, 5, trustKeys(9).authority.signer);
		expect(t.published).toEqual([]);
		expect(t.refusals().map((r) => r.fields.reason)).toEqual(["unpinned-key"]);
	});

	it("refuses a record whose signature does not verify", async () => {
		const t = await setup();
		const payload = trustPayload(trustRecord(5, keys));
		const envelope = await signEnvelope(
			keys.authority.signer,
			TRUST_RECORD_CONTEXT,
			payload,
		);
		await t.log.proposeTrust(
			create(SignedEnvelopeSchema, {
				...envelope,
				payload: trustPayload(trustRecord(5, trustKeys(9))),
			}),
		);
		await t.witness.poll();
		expect(t.published).toEqual([]);
		expect(t.refusals().map((r) => r.fields.reason)).toEqual([
			"authority-signature",
		]);
	});

	it("refuses a record with no matching fleet.TrustRotated entry, until that entry is in the chain", async () => {
		const t = await setup();
		const proposal = await propose(t, 5, keys.authority.signer, false);
		await t.witness.poll();
		expect(t.published).toEqual([]);
		expect(t.refusals().map((r) => r.fields)).toEqual([
			{ of: "trust", reason: "trust-rotation-unrecorded", sequence: 5 },
		]);

		// An entry with a different digest does not match.
		await appendEntries(t.log, [
			{
				type: "fleet.TrustRotated",
				subject: "trust",
				subjectSequence: 5,
				at: iso(T0 + 2),
				digest: sha256Hex("other"),
			},
		]);
		await t.witness.poll();
		expect(t.published).toEqual([]);

		await appendEntries(t.log, [
			{
				type: "fleet.TrustRotated",
				subject: "trust",
				subjectSequence: 5,
				at: iso(T0 + 3),
				digest: sha256Hex(proposal.payload),
			},
		]);
		await t.witness.poll();
		expect(t.published.map((p) => p.of)).toEqual(["trust"]);
	});
});

describe("createWitness end to end", () => {
	it("co-signs the authority's own checkpoints, and the chain with them verifies", async () => {
		const store = createMemoryEventStore();
		const log = memoryAuditLog();
		let clock = Date.now();
		const chain = createAuditChain({
			store,
			log,
			signer: keys.authority.signer,
			incarnation: 1,
			now: () => clock,
		});
		const logged: FleetLogEvent[] = [];
		const cosignatures: SignedEnvelope[] = [];
		const w = createWitness({
			log,
			registryChanges: () => ({ async stop() {} }),
			trust: () => pinned,
			signer: keys.witness.signer,
			async publish(cosignature, of) {
				if (of === "checkpoint") cosignatures.push(cosignature);
			},
			now: Date.now,
			log2: (event) => logged.push(event),
		});
		w.start();
		const actor = { kind: "service" as const, id: "test" };
		await store.append(
			"fleet-work-a",
			[{ type: "fleet.WorkOffered" }, { type: "fleet.WorkClaimed" }],
			{ expectedSeq: 0, actor, tenant: "acme" },
		);
		await chain.tick();
		clock += 60_000;
		await chain.tick();
		await chain.tick();
		await expect
			.poll(() => cosignatures.length, { timeout: 5_000, interval: 20 })
			.toBe(1);
		await w.stop();

		const [authority] = log.checkpoints;
		const [cosignature] = cosignatures;
		if (authority === undefined || cosignature === undefined)
			throw new Error("checkpoint");
		expect(Buffer.from(cosignature.payload)).toEqual(
			Buffer.from(authority.payload),
		);
		expect(
			verifyAuditChain(log.all, [witnessedOf(authority, cosignature)], pinned),
		).toEqual({
			ok: true,
			value: { entries: 3, finalThrough: 2 },
		});
		expect(logged).toEqual([]);
	});
});
