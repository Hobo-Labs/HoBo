/**
 * `@hobo/fleet/audit` (L06): the hash-chained audit log, its verification,
 * and the witness that co-signs checkpoints and trust records (§6.14).
 *
 * The frozen entry points of design §7.3; the modules beside this file are
 * private to the lane (see README.md here).
 */
import type {
	AuditEntry,
	SignedEnvelope,
	TrustRecord,
	WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import type {
	AuditLog,
	Clock,
	FleetEventStore,
	FleetLog,
	Outcome,
	Signer,
	Subscription,
} from "../ports.js";
import { auditChain } from "./chain.js";
import { verifyChain } from "./verify.js";
import { witnessProcess } from "./witness.js";

export function createAuditChain(
	deps: Readonly<{
		store: FleetEventStore;
		log: AuditLog;
		signer: Signer;
		incarnation: number;
		now: Clock;
	}>,
): Readonly<{ tick(): Promise<void> }> {
	return auditChain(deps);
}

export function verifyAuditChain(
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
	trust: TrustRecord,
): Outcome<Readonly<{ entries: number; finalThrough: number }>> {
	return verifyChain(entries, checkpoints, trust);
}

/**
 * Co-signs checkpoints and proposed trust records (§6.14); `publish` writes to fleet.audit.witness.
 * `registryChanges` reports a key and the record's own sequence (record_sequence, revision or trust sequence, decoded from the value), once per new sequence; re-signs are not reported. A change is matched by an AuditEntry with that subject and subject_sequence.
 */
export function createWitness(
	deps: Readonly<{
		log: AuditLog;
		registryChanges(
			handler: (key: string, recordSequence: number) => Promise<void>,
		): Subscription;
		trust(): TrustRecord;
		signer: Signer;
		publish(
			cosignature: SignedEnvelope,
			of: "checkpoint" | "trust",
		): Promise<void>;
		now: Clock;
		log2: FleetLog;
	}>,
): Readonly<{ start(): void; stop(): Promise<void> }> {
	return witnessProcess(deps);
}
