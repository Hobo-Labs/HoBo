/**
 * The relay mesh's board and claims on NATS JetStream key-value buckets.
 *
 * Two buckets with a TTL, so nothing in them needs cleaning up:
 *
 * - `<namespace>-mesh-nodes`: one key per node, its advertisement
 *   (`MeshAdvert` in `data-models/mesh.proto`, as protobuf JSON). A node that
 *   stops writing disappears when its entry ages out.
 * - `<namespace>-mesh-claims`: one key per job, the node that took it.
 *   `create` is atomic put-if-absent, so exactly one node wins a job. The
 *   entry ages out, which frees a job whose claimant died before starting it.
 *
 * And one without: `<namespace>-mesh-config` holds what the nodes share and
 * keep, the configuration under one key and the trusted-key set under another.
 *
 * This adapter carries advertisements; it does not judge them. Signing and
 * the trust level are `createTrustedMeshBoard` in `@hobo/ci/mesh`.
 *
 * The connection is made in the background and re-made for as long as the
 * process lives. Until it is up, and whenever it is down, every call rejects
 * quickly and the coordinator falls back to ranking alone; a worker never
 * waits for NATS to start or to come back.
 *
 * The client packages are imported on first use, so a worker with no mesh
 * configured never loads them.
 */
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

const NAMESPACE = /^[A-Za-z0-9_-]{1,32}$/;
const CONFIG_KEY = "configuration";
const TRUST_KEY = "trust";

export type NatsMeshOptions = Readonly<{
	/** One or more `nats://host:port` servers of the same cluster. */
	servers: readonly string[];
	/** Prefix of the two bucket names; one mesh per namespace. */
	namespace?: string;
	/** JetStream replicas for both buckets: 1 for a single server, 3 for a cluster. */
	replicas?: number;
	/** How long an advertisement that is not refreshed stays on the board. */
	advertTtlMs?: number;
	/** How long a claim blocks other nodes. */
	claimTtlMs?: number;
	/** Upper bound on any one request, so a slow server reads as down. */
	requestTimeoutMs?: number;
	token?: string | undefined;
	user?: string | undefined;
	password?: string | undefined;
	/** Shown in the server's connection list. */
	name?: string;
	onStatus?: (status: "connected" | "disconnected" | "closed") => void;
}>;

export type NatsMesh = Readonly<{
	board: MeshBoard;
	claims: MeshClaims;
	/** The configuration the mesh's nodes share; kept until replaced, with history. */
	config: MeshConfigStore;
	/**
	 * The mesh's trust settings (`MeshTrustConfig`): which identity keys its
	 * operator vouches for. Same bucket and rules as `config`, its own key.
	 */
	trust: MeshConfigStore;
	/** Resolves once the first connection and the buckets are ready. */
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
				/** When the server stored this revision. */
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
			// Keep trying for the life of the process, from the first attempt on.
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
				// A TTL of zero keeps entries until they are replaced.
				return await kvm.create(
					name,
					ttl > 0 ? { ttl, replicas, history } : { replicas, history },
				);
			} catch {
				// Another node created it with other settings; use theirs.
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
			// No TTL, and the last few revisions kept so a bad change can be read back.
			config: await open(`${namespace}-mesh-config`, 0, 10),
		};
		connected = true;
		options.onStatus?.("connected");
	})();
	// A failed first connect surfaces through `ready`; calls just see "not connected".
	ready.catch(() => undefined);

	function use(): { nodes: Bucket; claims: Bucket; config: Bucket } {
		if (!buckets || !connected) throw new Error("NATS not connected");
		return buckets;
	}

	/** One key of the config bucket, replaced only by naming its current revision. */
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
					// Someone else wrote first. If they wrote the same thing there is
					// nothing to reconcile; otherwise the caller must read and decide.
					const entry = await config.get(key);
					if (!entry || entry.operation !== "PUT") throw error;
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
				for await (const key of await nodes.keys()) {
					const entry = await nodes.get(key);
					if (!entry || entry.operation !== "PUT") continue;
					// An advertisement this version cannot read is a node it cannot rank.
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
						// Most often the key exists. Read who holds it; if nobody does
						// (it aged out in between) try once more, then give up.
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

/**
 * The mesh's shared configuration, read over a connection made just for
 * this: a node with no configuration of its own asks before it has started
 * anything else. `undefined` when none is stored or NATS does not answer in
 * `timeoutMs`.
 */
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
