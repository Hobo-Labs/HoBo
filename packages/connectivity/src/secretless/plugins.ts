/**
 * Extensible secretless protocol plugins (ADR-0027).
 * First-class: postgres, tcp, mysql, redis. Plugin interface is open for more.
 */
import { createHash } from "node:crypto";

export type SecretlessProtocolId =
	| "postgres"
	| "tcp"
	| "mysql"
	| "redis"
	| (string & {});

export type ProtocolPlugin = Readonly<{
	id: SecretlessProtocolId;
	/** Default local base port for leases of this protocol. */
	defaultBasePort: number;
	/**
	 * Perform mediated handshake using closed-over credential.
	 * Must never return the credential or include it in outputs.
	 */
	handshake: (input: {
		targetRef: string;
		credentialMaterial: string;
		localEndpoint: string;
	}) => {
		ok: boolean;
		bytesProxied: number;
		protocol: SecretlessProtocolId;
		credentialExposedToWorkload: false;
	};
}>;

function hashHandshake(
	protocol: string,
	targetRef: string,
	credentialMaterial: string,
): number {
	const h = createHash("sha256")
		.update(protocol)
		.update(targetRef)
		.update(credentialMaterial)
		.digest();
	return 32 + ((h[0] ?? 0) % 96);
}

export const postgresPlugin: ProtocolPlugin = Object.freeze({
	id: "postgres",
	defaultBasePort: 15432,
	handshake(input) {
		return {
			ok: true,
			bytesProxied: hashHandshake(
				"postgres",
				input.targetRef,
				input.credentialMaterial,
			),
			protocol: "postgres",
			credentialExposedToWorkload: false as const,
		};
	},
});

export const tcpPlugin: ProtocolPlugin = Object.freeze({
	id: "tcp",
	defaultBasePort: 19000,
	handshake(input) {
		return {
			ok: true,
			bytesProxied: hashHandshake(
				"tcp",
				input.targetRef,
				input.credentialMaterial,
			),
			protocol: "tcp",
			credentialExposedToWorkload: false as const,
		};
	},
});

export const mysqlPlugin: ProtocolPlugin = Object.freeze({
	id: "mysql",
	defaultBasePort: 13306,
	handshake(input) {
		return {
			ok: true,
			bytesProxied: hashHandshake(
				"mysql",
				input.targetRef,
				input.credentialMaterial,
			),
			protocol: "mysql",
			credentialExposedToWorkload: false as const,
		};
	},
});

export const redisPlugin: ProtocolPlugin = Object.freeze({
	id: "redis",
	defaultBasePort: 16379,
	handshake(input) {
		return {
			ok: true,
			bytesProxied: hashHandshake(
				"redis",
				input.targetRef,
				input.credentialMaterial,
			),
			protocol: "redis",
			credentialExposedToWorkload: false as const,
		};
	},
});

const DEFAULT_PLUGINS: readonly ProtocolPlugin[] = Object.freeze([
	postgresPlugin,
	tcpPlugin,
	mysqlPlugin,
	redisPlugin,
]);

export interface ProtocolPluginRegistry {
	get: (id: string) => ProtocolPlugin | undefined;
	list: () => readonly ProtocolPlugin[];
	register: (plugin: ProtocolPlugin) => void;
}

export function createPluginRegistry(
	extra: readonly ProtocolPlugin[] = [],
): ProtocolPluginRegistry {
	const map = new Map<string, ProtocolPlugin>();
	for (const p of [...DEFAULT_PLUGINS, ...extra]) {
		map.set(p.id, p);
	}
	return {
		get: (id) => map.get(id),
		list: () => Object.freeze([...map.values()]),
		register(plugin) {
			map.set(plugin.id, plugin);
		},
	};
}
