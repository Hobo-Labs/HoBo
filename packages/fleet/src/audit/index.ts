/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/audit` (L06): the hash-chained audit log, its verification,
 * and the witness that co-signs checkpoints and trust records (§6.14).
 *
 * Contract commit: every body throws `FleetNotImplemented`; L06 replaces them.
 */
import type {
	AuditEntry,
	SignedEnvelope,
	TrustRecord,
	WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import { FleetNotImplemented } from "../errors.js";
import type {
	AuditLog,
	Clock,
	FleetEventStore,
	FleetLog,
	Outcome,
	Signer,
	Subscription,
} from "../ports.js";

export function createAuditChain(
	deps: Readonly<{
		store: FleetEventStore;
		log: AuditLog;
		signer: Signer;
		incarnation: number;
		now: Clock;
	}>,
): Readonly<{ tick(): Promise<void> }> {
	throw new FleetNotImplemented("createAuditChain");
}

export function verifyAuditChain(
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
	trust: TrustRecord,
): Outcome<Readonly<{ entries: number; finalThrough: number }>> {
	throw new FleetNotImplemented("verifyAuditChain");
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
	throw new FleetNotImplemented("createWitness");
}
