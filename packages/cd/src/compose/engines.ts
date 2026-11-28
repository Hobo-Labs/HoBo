import type {
	ClusterSyncPort,
	Outcome,
	PublisherPort,
	Refusal,
} from "../ports.js";
import { composeReason } from "./errors.js";

export const CD_ENGINE_KIND = Object.freeze({
	GITOPS_PUBLISHER: "gitops-publisher",
	CLUSTER_SYNC: "cluster-sync",
} as const);

export type CdEngineKind = (typeof CD_ENGINE_KIND)[keyof typeof CD_ENGINE_KIND];

export const LEGACY_PUBLISHER_TARGET: ReadonlyMap<string, string> = new Map([
	["argo", "argo-cd"],
]);

export type CdEngineRegistration =
	| Readonly<{
			name: string;
			kind: typeof CD_ENGINE_KIND.GITOPS_PUBLISHER;
			publisher: PublisherPort;
	  }>
	| Readonly<{
			name: string;
			kind: typeof CD_ENGINE_KIND.CLUSTER_SYNC;
			clusterSync: ClusterSyncPort;
	  }>;

export type CdEngineRecord = Readonly<{
	name: string;
	kind: CdEngineKind;
	target: string;
	publisher?: PublisherPort;
	clusterSync?: ClusterSyncPort;
}>;

export interface CdEngineRegistry {
	get(name: string): Outcome<CdEngineRecord>;
	publisher(name: string): Outcome<PublisherPort>;
	clusterSync(name: string): Outcome<ClusterSyncPort>;
	names(): readonly string[];
	kind(name: string): CdEngineKind | undefined;
}

function resolveTargetName(name: string): string {
	return LEGACY_PUBLISHER_TARGET.get(name) ?? name;
}

function engineUnknown(name: string, resolved: string): Refusal {
	return {
		ok: false,
		reasons: [
			composeReason(
				"compose-engine-unknown",
				`no CD engine registered as ${name}${resolved === name ? "" : ` (resolved from legacy alias to ${resolved})`}`,
				name,
			),
		],
	};
}

function engineNotPublisher(name: string): Refusal {
	return {
		ok: false,
		reasons: [
			composeReason(
				"compose-engine-not-publisher",
				`engine ${name} is not a GitOps publisher`,
				name,
			),
		],
	};
}

function engineNotClusterSync(name: string): Refusal {
	return {
		ok: false,
		reasons: [
			composeReason(
				"compose-engine-not-cluster-sync",
				`engine ${name} is not a cluster sync client`,
				name,
			),
		],
	};
}

function recordOf(entry: CdEngineRegistration, name: string): CdEngineRecord {
	if (entry.kind === CD_ENGINE_KIND.GITOPS_PUBLISHER) {
		return Object.freeze({
			name,
			kind: entry.kind,
			target: entry.publisher.target,
			publisher: entry.publisher,
		});
	}
	return Object.freeze({
		name,
		kind: entry.kind,
		target: entry.clusterSync.target,
		clusterSync: entry.clusterSync,
	});
}

export function createCdEngineRegistry(
	registrations: readonly CdEngineRegistration[],
): CdEngineRegistry {
	const byName = new Map<string, CdEngineRecord>();
	for (const entry of registrations) {
		const name = resolveTargetName(entry.name);
		if (byName.has(name)) {
			throw new Error(`duplicate CD engine registration: ${name}`);
		}
		byName.set(name, recordOf(entry, name));
	}
	return Object.freeze({
		get(name: string): Outcome<CdEngineRecord> {
			const resolved = resolveTargetName(name);
			const record = byName.get(resolved);
			if (record) return { ok: true as const, value: record };
			return engineUnknown(name, resolved);
		},
		publisher(name: string): Outcome<PublisherPort> {
			const resolved = resolveTargetName(name);
			const record = byName.get(resolved);
			if (record?.publisher)
				return { ok: true as const, value: record.publisher };
			if (record) return engineNotPublisher(resolved);
			return engineUnknown(name, resolved);
		},
		clusterSync(name: string): Outcome<ClusterSyncPort> {
			const resolved = resolveTargetName(name);
			const record = byName.get(resolved);
			if (record?.clusterSync)
				return { ok: true as const, value: record.clusterSync };
			if (record) return engineNotClusterSync(resolved);
			return engineUnknown(name, resolved);
		},
		names() {
			return [...byName.keys()].sort();
		},
		kind(name: string) {
			return byName.get(resolveTargetName(name))?.kind;
		},
	});
}

export function gitopsPublisherRegistration(
	name: string,
	port: PublisherPort,
): CdEngineRegistration {
	return Object.freeze({
		name,
		kind: CD_ENGINE_KIND.GITOPS_PUBLISHER,
		publisher: port,
	});
}

export function clusterSyncRegistration(
	name: string,
	port: ClusterSyncPort,
): CdEngineRegistration {
	return Object.freeze({
		name,
		kind: CD_ENGINE_KIND.CLUSTER_SYNC,
		clusterSync: port,
	});
}

export function registrationsFromPublisherPorts(
	entries: readonly Readonly<{ name: string; port: PublisherPort }>[],
): readonly CdEngineRegistration[] {
	return entries.map((e) => gitopsPublisherRegistration(e.name, e.port));
}
