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

export { verifyChainAcrossTrust } from "./verify.js";
