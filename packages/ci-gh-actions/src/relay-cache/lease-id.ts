import { createHash } from "node:crypto";

export const RELAY_LEASE_NAMESPACE = "05b8d12d-78ba-5187-b4d2-f53efe23deb0";

export const RELAY_MAX_GENERATION = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETERMINISTIC_LEASE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidV5(namespace: string, name: string): string {
	if (!UUID.test(namespace)) throw new Error("invalid UUID namespace");
	const hash = createHash("sha1")
		.update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
		.update(name, "utf8")
		.digest()
		.subarray(0, 16);
	hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
	hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
	const hex = hash.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type RelayJobIdentity = Readonly<{
	repositoryId: number;
	jobId: number;
	runAttempt: number;
}>;

export type RelayJobKey = string & { readonly __brand: "RelayJobKey" };
export type RelayLeaseId = string & { readonly __brand: "RelayLeaseId" };

function positive(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`invalid ${name}`);
	return value;
}

function generationOf(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > RELAY_MAX_GENERATION)
		throw new Error("invalid requeue generation");
	return value;
}

export function relayJobKey(job: RelayJobIdentity): RelayJobKey {
	return `${positive(job.repositoryId, "repository id")}:${positive(job.jobId, "job id")}:${positive(job.runAttempt, "run attempt")}` as RelayJobKey;
}

export function parseRelayJobKey(value: string): RelayJobIdentity {
	const match = /^(\d{1,16}):(\d{1,16}):(\d{1,10})$/.exec(value);
	if (!match) throw new Error("invalid relay job key");
	const identity = {
		repositoryId: Number(match[1]),
		jobId: Number(match[2]),
		runAttempt: Number(match[3]),
	};
	relayJobKey(identity);
	return identity;
}

export function relayLeaseId(
	job: RelayJobIdentity,
	generation = 0,
): RelayLeaseId {
	const key = relayJobKey(job);
	const g = generationOf(generation);
	return uuidV5(
		RELAY_LEASE_NAMESPACE,
		g > 0 ? `${key}:g${g}` : key,
	) as RelayLeaseId;
}

export function isDeterministicLeaseId(value: string): value is RelayLeaseId {
	return DETERMINISTIC_LEASE.test(value);
}

export function relayLeaseNames(leaseId: string) {
	return {
		runner: `hobo-${leaseId}`,
		bridgeRunTitle: `HoBo lease ${leaseId}`,
		sandbox: `hobo-${leaseId}`,
		proxySandbox: `hobo-proxy-${leaseId}`,
	} as const;
}

export function relayLeaseCandidates(
	job: RelayJobIdentity,
	maxGeneration: number,
): { generation: number; leaseId: RelayLeaseId }[] {
	const bound = generationOf(maxGeneration);
	const out: { generation: number; leaseId: RelayLeaseId }[] = [];
	for (let generation = 0; generation <= bound; generation++)
		out.push({ generation, leaseId: relayLeaseId(job, generation) });
	return out;
}
