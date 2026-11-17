import { randomUUID } from "node:crypto";

import {
	createPluginRegistry,
	type ProtocolPlugin,
	type SecretlessProtocolId,
} from "./plugins.js";

export type SecretlessProtocol = SecretlessProtocolId;

export type IsolationTier = "shared" | "per-tenant" | "per-workload";

export type SecretlessLease = Readonly<{
	leaseId: string;
	protocol: SecretlessProtocol;
	localEndpoint: string;
	targetRef: string;
	expiresAt: string;
	hasCredential: true;
	isolation: IsolationTier;
	tenantId?: string;
	workloadId?: string;
}>;

export type SecretlessConnectorOptions = Readonly<{
	localHost?: string;
	basePort?: number;
	leaseTtlSeconds?: number;
	isolation?: IsolationTier;
	plugins?: readonly ProtocolPlugin[];
	now?: () => string;
}>;

type InternalLease = {
	lease: SecretlessLease;
	credentialMaterial: string;
	renewals: number;
};

export type SecretlessConnector = {
	readonly openLease: (input: {
		protocol: SecretlessProtocol;
		targetRef: string;
		credentialMaterial: string;
		namedHost?: string;
		tenantId?: string;
		workloadId?: string;
		isolation?: IsolationTier;
	}) => SecretlessLease;
	readonly renewLease: (leaseId: string) => SecretlessLease | null;
	readonly closeLease: (leaseId: string) => boolean;
	readonly getLease: (leaseId: string) => SecretlessLease | undefined;
	readonly mediate: (leaseId: string) => {
		ok: boolean;
		protocol: SecretlessProtocol;
		bytesProxied: number;
		credentialExposedToWorkload: false;
	};
	readonly listLeases: (filter?: {
		tenantId?: string;
		workloadId?: string;
	}) => readonly SecretlessLease[];
	readonly registerPlugin: (plugin: ProtocolPlugin) => void;
	readonly listPlugins: () => readonly ProtocolPlugin[];
};

export function createSecretlessConnector(
	options: SecretlessConnectorOptions = {},
): SecretlessConnector {
	const localHost = options.localHost ?? "127.0.0.1";
	const ttl = options.leaseTtlSeconds ?? 900;
	const defaultIsolation = options.isolation ?? "shared";
	const now = options.now ?? (() => new Date().toISOString());
	const leases = new Map<string, InternalLease>();
	const registry = createPluginRegistry(options.plugins ?? []);
	let portSeq = 0;

	function expireAt(from: string): string {
		return new Date(Date.parse(from) + ttl * 1000).toISOString();
	}

	function resolveIsolation(input: {
		tenantId?: string;
		workloadId?: string;
		isolation?: IsolationTier;
	}): IsolationTier {
		if (input.isolation) return input.isolation;
		if (defaultIsolation !== "shared") return defaultIsolation;
		if (input.workloadId) return "per-workload";
		if (input.tenantId) return "per-tenant";
		return "shared";
	}

	return {
		openLease(input) {
			if (!input.credentialMaterial) {
				throw new Error("secretless lease requires credential material");
			}
			const plugin = registry.get(input.protocol);
			if (!plugin) {
				throw new Error(`no secretless plugin for protocol ${input.protocol}`);
			}
			portSeq += 1;
			const leaseId = `lease_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
			const port = (options.basePort ?? plugin.defaultBasePort) + portSeq;
			const host = input.namedHost ?? localHost;
			const localEndpoint = `${host}:${port}`;
			const isolation = resolveIsolation(input);
			const t = now();
			const lease: SecretlessLease = Object.freeze({
				leaseId,
				protocol: input.protocol,
				localEndpoint,
				targetRef: input.targetRef,
				expiresAt: expireAt(t),
				hasCredential: true as const,
				isolation,
				...(input.tenantId !== undefined
					? { tenantId: input.tenantId }
					: undefined),
				...(input.workloadId !== undefined
					? { workloadId: input.workloadId }
					: undefined),
			});
			leases.set(leaseId, {
				lease,
				credentialMaterial: input.credentialMaterial,
				renewals: 0,
			});
			return lease;
		},
		renewLease(leaseId) {
			const internal = leases.get(leaseId);
			if (!internal) return null;
			const t = now();
			if (Date.parse(t) >= Date.parse(internal.lease.expiresAt)) {
				leases.delete(leaseId);
				return null;
			}
			const renewed: SecretlessLease = Object.freeze({
				...internal.lease,
				expiresAt: expireAt(t),
			});
			leases.set(leaseId, {
				...internal,
				lease: renewed,
				renewals: internal.renewals + 1,
			});
			return renewed;
		},
		closeLease(leaseId) {
			return leases.delete(leaseId);
		},
		getLease(leaseId) {
			return leases.get(leaseId)?.lease;
		},
		mediate(leaseId) {
			const internal = leases.get(leaseId);
			if (!internal) {
				return {
					ok: false,
					protocol: "tcp",
					bytesProxied: 0,
					credentialExposedToWorkload: false as const,
				};
			}
			const t = now();
			if (Date.parse(t) >= Date.parse(internal.lease.expiresAt)) {
				leases.delete(leaseId);
				return {
					ok: false,
					protocol: internal.lease.protocol,
					bytesProxied: 0,
					credentialExposedToWorkload: false as const,
				};
			}
			const plugin = registry.get(internal.lease.protocol);
			if (!plugin) {
				return {
					ok: false,
					protocol: internal.lease.protocol,
					bytesProxied: 0,
					credentialExposedToWorkload: false as const,
				};
			}
			return plugin.handshake({
				targetRef: internal.lease.targetRef,
				credentialMaterial: internal.credentialMaterial,
				localEndpoint: internal.lease.localEndpoint,
			});
		},
		listLeases(filter) {
			let items = [...leases.values()].map((i) => i.lease);
			if (filter?.tenantId) {
				items = items.filter((l) => l.tenantId === filter.tenantId);
			}
			if (filter?.workloadId) {
				items = items.filter((l) => l.workloadId === filter.workloadId);
			}
			return Object.freeze(
				items.sort((a, b) => a.leaseId.localeCompare(b.leaseId)),
			);
		},
		registerPlugin(plugin) {
			registry.register(plugin);
		},
		listPlugins() {
			return registry.list();
		},
	};
}

export function openPostgresSecretlessLease(
	connector: SecretlessConnector,
	input: {
		targetRef: string;
		credentialMaterial: string;
		namedHost?: string;
		tenantId?: string;
		workloadId?: string;
	},
): SecretlessLease {
	return connector.openLease({
		protocol: "postgres",
		targetRef: input.targetRef,
		credentialMaterial: input.credentialMaterial,
		...(input.namedHost !== undefined
			? { namedHost: input.namedHost }
			: undefined),
		...(input.tenantId !== undefined
			? { tenantId: input.tenantId }
			: undefined),
		...(input.workloadId !== undefined
			? { workloadId: input.workloadId }
			: undefined),
	});
}

export function openMysqlSecretlessLease(
	connector: SecretlessConnector,
	input: {
		targetRef: string;
		credentialMaterial: string;
		namedHost?: string;
		tenantId?: string;
	},
): SecretlessLease {
	return connector.openLease({
		protocol: "mysql",
		targetRef: input.targetRef,
		credentialMaterial: input.credentialMaterial,
		...(input.namedHost !== undefined
			? { namedHost: input.namedHost }
			: undefined),
		...(input.tenantId !== undefined
			? { tenantId: input.tenantId }
			: undefined),
	});
}

export function openRedisSecretlessLease(
	connector: SecretlessConnector,
	input: {
		targetRef: string;
		credentialMaterial: string;
		namedHost?: string;
		tenantId?: string;
	},
): SecretlessLease {
	return connector.openLease({
		protocol: "redis",
		targetRef: input.targetRef,
		credentialMaterial: input.credentialMaterial,
		...(input.namedHost !== undefined
			? { namedHost: input.namedHost }
			: undefined),
		...(input.tenantId !== undefined
			? { tenantId: input.tenantId }
			: undefined),
	});
}
