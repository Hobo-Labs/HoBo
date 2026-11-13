// A change of the trust record (design §6.14, §7.4): journal
// `fleet.TrustRotated` first, so the witness finds its audit entry; then
// publish the authority-signed record on `fleet.audit.trust`, wait for the
// witness's co-signature, and put the witnessed record in the registry.
// Only key rotation and restore change the trust record. Private to L27.
import { createHash } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { OptimisticSequenceConflictError } from "@hobo/core";
import {
	type AuthorityBus,
	type Clock,
	FLEET_TRUST_STREAM,
	type FleetEventStore,
	type FleetLog,
	type Outcome,
	type Signer,
	TRUST_RECORD_CONTEXT,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";

// public-contract: the journal event of a trust-record change (§7.5).
const TRUST_ROTATED = "fleet.TrustRotated";
const APPEND_RETRIES = 8;

export type TrustDeps = Readonly<{
	store: FleetEventStore;
	bus: Pick<AuthorityBus, "registry" | "publisher" | "audit">;
	/** The tenant every appended event is filed under. */
	tenant: string;
	/**
	 * Runs the audit chain once, so the journalled event becomes an entry. Only
	 * when no authority is running to do it (a restore); otherwise the running
	 * authority's tick does it and the witness, which polls, finds it.
	 */
	tickAudit?: () => Promise<void>;
	witnessTimeoutMs: number;
	now: Clock;
	log: FleetLog;
}>;

export type TrustChange = Readonly<{
	/** The proposed record's protobuf bytes, exactly as journalled and signed. */
	payload: Uint8Array;
	signer: Signer;
	/** Why the record changes: `rotate:<which>:<step>` or `restore`. */
	reason: string;
}>;

/** The record after `pinned` with `change` applied: the next sequence, issued now. */
export function nextTrustRecord(
	pinned: TrustRecord,
	nowMs: number,
	change: Partial<
		Pick<TrustRecord, "authorityKeys" | "witnessKeys" | "authorityIncarnation">
	>,
): Uint8Array {
	return toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: pinned.tenant,
			sequence: pinned.sequence + 1,
			authorityKeys: [...(change.authorityKeys ?? pinned.authorityKeys)],
			witnessKeys: [...(change.witnessKeys ?? pinned.witnessKeys)],
			authorityIncarnation:
				change.authorityIncarnation ?? pinned.authorityIncarnation,
			issuer: pinned.issuer,
			jwksUri: pinned.jwksUri,
			issuedAt: new Date(nowMs).toISOString(),
		}),
	);
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
	return a !== undefined && Buffer.from(a).equals(Buffer.from(b));
}

/** Appends `fleet.TrustRotated` for `payload` once (idempotent on its digest). */
async function journal(
	deps: TrustDeps,
	payload: Uint8Array,
	record: TrustRecord,
	reason: string,
): Promise<void> {
	let head = 0;
	for await (const event of deps.store.read(FLEET_TRUST_STREAM))
		head = event.seq;
	for (let attempt = 0; ; attempt += 1) {
		try {
			await deps.store.append(
				FLEET_TRUST_STREAM,
				[
					{
						type: TRUST_ROTATED,
						data: {
							record: Buffer.from(payload).toString("base64"),
							sequence: record.sequence,
							authorityIncarnation: record.authorityIncarnation,
							reason,
						},
						meta: {
							idempotencyKey: `trust-${record.sequence}-${digest(payload)}`,
							subjectSequence: record.sequence,
						},
					},
				],
				{
					expectedSeq: head,
					actor: { kind: "service", id: "fleet-ops" },
					tenant: deps.tenant,
				},
			);
			return;
		} catch (error) {
			if (
				!(error instanceof OptimisticSequenceConflictError) ||
				attempt >= APPEND_RETRIES
			)
				throw error;
			head = error.actualSeq;
		}
	}
}

/**
 * Journals, proposes and waits for the witness. Resumable: proposing the same
 * bytes again journals nothing new, and a record the registry already pins is
 * returned as it is.
 */
export async function changeTrust(
	deps: TrustDeps,
	change: TrustChange,
): Promise<Outcome<WitnessedEnvelope>> {
	const record = fromBinary(TrustRecordSchema, change.payload);
	const pinned = deps.bus.registry.trustEnvelope();
	if (
		pinned !== undefined &&
		sameBytes(pinned.authority?.payload, change.payload)
	)
		return { ok: true, value: pinned };
	if (deps.bus.registry.trust().sequence >= record.sequence)
		return {
			ok: false,
			error: {
				code: "conflict",
				message: `the registry already pins trust record ${deps.bus.registry.trust().sequence}`,
			},
		};

	await journal(deps, change.payload, record, change.reason);
	if (deps.tickAudit !== undefined) await deps.tickAudit();

	let settle: (witnessed: WitnessedEnvelope) => void = () => {};
	const witnessed = new Promise<WitnessedEnvelope>((resolve) => {
		settle = resolve;
	});
	const subscription = deps.bus.audit.onTrustWitnessed(async (candidate) => {
		if (sameBytes(candidate.authority?.payload, change.payload))
			settle(candidate);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), deps.witnessTimeoutMs);
		timer.unref?.();
	});
	try {
		await deps.bus.audit.proposeTrust(
			await signEnvelope(change.signer, TRUST_RECORD_CONTEXT, change.payload),
		);
		const result = await Promise.race([witnessed, timedOut]);
		if (result === undefined)
			return {
				ok: false,
				error: {
					code: "unavailable",
					message: `the witness did not co-sign trust record ${record.sequence} within ${deps.witnessTimeoutMs} ms`,
					detail: { sequence: String(record.sequence) },
				},
			};
		await deps.bus.publisher.putTrust(result);
		deps.log("hobo_fleet_trust_rotated", {
			sequence: record.sequence,
			incarnation: record.authorityIncarnation,
			reason: change.reason,
		});
		return { ok: true, value: result };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		await subscription.stop();
	}
}
