import type {
	MeshBoard,
	MeshClaims,
	MeshConfigStore,
	MeshNode,
} from "@hobo/ci/mesh";
import {
	MESH_NODE_ID,
	meshAdvertJson,
	parseMeshAdvert,
} from "./mesh-records.js";

export { MESH_NODE_ID };
export const MESH_MAX_ADVERTS_READ = 1024;

const NAMESPACE = /^[A-Za-z0-9_-]{1,32}$/;
const CONFIG_KEY = "configuration";
const TRUST_KEY = "trust";

export type NatsMeshOptions = Readonly<{
	servers: readonly string[];
	namespace?: string;
	replicas?: number;
	advertTtlMs?: number;
	claimTtlMs?: number;
	requestTimeoutMs?: number;
	token?: string | undefined;
	user?: string | undefined;
	password?: string | undefined;
	name?: string;
	maxNodes?: number;
	onNodesCapped?: (limit: number) => void;
	onStatus?: (status: "connected" | "disconnected" | "closed") => void;
}>;

export type NatsMesh = Readonly<{
	board: MeshBoard;
	claims: MeshClaims;
	config: MeshConfigStore;
	trust: MeshConfigStore;
	ready: Promise<void>;
	close(): Promise<void>;
}>;

type Bucket = Readonly<{
	create(key: string, value: string): Promise<number>;
	put(key: string, value: string): Promise<number>;
	update(key: string, value: string, revision: number): Promise<number>;
	get(key: string): Promise<
		| {
				operation: string;
				revision: number;
				created: Date;
				string(): string;
		  }
		| null
		| undefined
	>;
	keys(): Promise<AsyncIterable<string>>;
}>;

export function createNatsMesh(options: NatsMeshOptions): NatsMesh {
	const namespace = options.namespace ?? "hobo-ci";
	if (!NAMESPACE.test(namespace)) throw new Error("invalid mesh namespace");
	if (options.servers.length === 0) throw new Error("no NATS servers");
	const replicas = options.replicas ?? 1;
	const timeout = options.requestTimeoutMs ?? 2_000;
	const maxNodes = options.maxNodes ?? MESH_MAX_ADVERTS_READ;
	let cappedAt = Number.NEGATIVE_INFINITY;
	let buckets: { nodes: Bucket; claims: Bucket; config: Bucket } | undefined;
	let connected = false;
	let closing = false;
	let disconnect: (() => Promise<void>) | undefined;

	const ready = (async () => {
		const { connect } = await import("@nats-io/transport-node");
		const { jetstream } = await import("@nats-io/jetstream");
		const { Kvm } = await import("@nats-io/kv");
		const settings: NonNullable<Parameters<typeof connect>[0]> = {
			servers: [...options.servers],
			name: options.name ?? "hobo-ci-mesh",
			waitOnFirstConnect: true,
			maxReconnectAttempts: -1,
			reconnectTimeWait: 2_000,
			timeout: 5_000,
		};
		if (options.token !== undefined) settings.token = options.token;
		if (options.user !== undefined) settings.user = options.user;
		if (options.password !== undefined) settings.pass = options.password;
		const connection = await connect(settings);
		disconnect = () => connection.close();
		if (closing) {
			await connection.close();
			return;
		}
		void (async () => {
			for await (const status of connection.status()) {
				if (status.type === "disconnect") {
					connected = false;
					options.onStatus?.("disconnected");
				} else if (status.type === "reconnect") {
					connected = true;
					options.onStatus?.("connected");
				}
			}
			connected = false;
			options.onStatus?.("closed");
		})();
		const kvm = new Kvm(jetstream(connection, { timeout }));
		const open = async (
			name: string,
			ttl: number,
			history = 1,
		): Promise<Bucket> => {
			try {
				return await kvm.create(
					name,
					ttl > 0 ? { ttl, replicas, history } : { replicas, history },
				);
			} catch {
				return await kvm.open(name);
			}
		};
		buckets = {
			nodes: await open(
				`${namespace}-mesh-nodes`,
				options.advertTtlMs ?? 60_000,
			),
			claims: await open(
				`${namespace}-mesh-claims`,
				options.claimTtlMs ?? 120_000,
			),
			config: await open(`${namespace}-mesh-config`, 0, 10),
		};
		connected = true;
		options.onStatus?.("connected");
	})();
	ready.catch(() => undefined);

	function use(): { nodes: Bucket; claims: Bucket; config: Bucket } {
		if (!buckets || !connected) throw new Error("NATS not connected");
		return buckets;
	}

	function keyed(key: string): MeshConfigStore {
		return {
			async read() {
				const entry = await use().config.get(key);
				return entry && entry.operation === "PUT"
					? { value: entry.string(), revision: entry.revision }
					: undefined;
			},
			async publish(value, expectedRevision) {
				const { config } = use();
				try {
					return {
						revision:
							expectedRevision === undefined
								? await config.create(key, value)
								: await config.update(key, value, expectedRevision),
					};
				} catch (error) {
					const entry = await config.get(key);
					if (entry?.operation !== "PUT") throw error;
					return entry.string() === value
						? { revision: entry.revision }
						: "conflict";
				}
			},
		};
	}

	return {
		ready,
		board: {
			async advertise(node) {
				await use().nodes.put(node.id, meshAdvertJson(node));
			},
			async nodes() {
				const { nodes } = use();
				const found: MeshNode[] = [];
				let read = 0;
				for await (const key of await nodes.keys()) {
					if (read >= maxNodes) {
						if (Date.now() - cappedAt >= 60_000) {
							cappedAt = Date.now();
							options.onNodesCapped?.(maxNodes);
						}
						break;
					}
					read += 1;
					const entry = await nodes.get(key);
					if (entry?.operation !== "PUT") continue;
					const advert = parseMeshAdvert(entry.string());
					if (advert?.id === key)
						found.push({ ...advert, seenAtMs: entry.created.getTime() });
				}
				return found;
			},
		},
		claims: {
			async tryClaim(jobId, nodeId) {
				if (!MESH_NODE_ID.test(nodeId)) throw new Error("invalid mesh node id");
				const { claims } = use();
				const key = `job.${jobId}`;
				for (let attempt = 0; ; attempt += 1) {
					try {
						await claims.create(key, nodeId);
						return "claimed";
					} catch (error) {
						const entry = await claims.get(key);
						if (entry && entry.operation === "PUT")
							return entry.string() === nodeId ? "claimed" : "held";
						if (attempt > 0) throw error;
					}
				}
			},
		},
		config: keyed(CONFIG_KEY),
		trust: keyed(TRUST_KEY),
		async close() {
			closing = true;
			connected = false;
			await disconnect?.();
		},
	};
}

export async function readNatsMeshConfig(
	options: NatsMeshOptions,
	timeoutMs = 5000,
): Promise<{ value: string; revision: number } | undefined> {
	const mesh = createNatsMesh(options);
	try {
		const ready = await Promise.race([
			mesh.ready.then(() => true),
			new Promise<boolean>((resolve) =>
				setTimeout(() => resolve(false), timeoutMs).unref(),
			),
		]);
		return ready ? await mesh.config.read() : undefined;
	} catch {
		return undefined;
	} finally {
		await mesh.close().catch(() => undefined);
	}
}
