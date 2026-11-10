/**
 * The relay mesh's board and claims on NATS JetStream key-value buckets.
 *
 * Two buckets, both with a TTL so nothing here needs cleaning up:
 *
 * - `<namespace>-mesh-nodes`: one key per node, its advertisement. A node
 *   that stops writing disappears when its entry ages out.
 * - `<namespace>-mesh-claims`: one key per job, the node that took it.
 *   `create` is atomic put-if-absent, so exactly one node wins a job. The
 *   entry ages out, which frees a job whose claimant died before starting it.
 *
 * The connection is made in the background and re-made for as long as the
 * process lives. Until it is up, and whenever it is down, every call rejects
 * quickly and the coordinator falls back to ranking alone; a worker never
 * waits for NATS to start or to come back.
 *
 * The client packages are imported on first use, so a worker with no mesh
 * configured never loads them.
 */
import type { MeshBoard, MeshClaims, MeshNode } from "@hobo/ci/mesh";
import { z } from "zod";

/** Node ids are bucket keys and hash inputs: a short, plain token. */
export const MESH_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACE = /^[A-Za-z0-9_-]{1,32}$/;

const Advert = z.object({
	id: z.string().regex(MESH_NODE_ID),
	freeSlots: z.number().int().min(0).max(4096),
	healthy: z.boolean(),
	labels: z.array(z.string().min(1).max(80)).max(32),
	validUntilMs: z.number().int().nonnegative(),
});

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
	/** Resolves once the first connection and both buckets are ready. */
	ready: Promise<void>;
	close(): Promise<void>;
}>;

type Bucket = Readonly<{
	create(key: string, value: string): Promise<number>;
	put(key: string, value: string): Promise<number>;
	get(
		key: string,
	): Promise<{ operation: string; string(): string } | null | undefined>;
	keys(): Promise<AsyncIterable<string>>;
}>;

export function createNatsMesh(options: NatsMeshOptions): NatsMesh {
	const namespace = options.namespace ?? "hobo-ci";
	if (!NAMESPACE.test(namespace)) throw new Error("invalid mesh namespace");
	if (options.servers.length === 0) throw new Error("no NATS servers");
	const replicas = options.replicas ?? 1;
	const timeout = options.requestTimeoutMs ?? 2_000;
	let buckets: { nodes: Bucket; claims: Bucket } | undefined;
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
		const open = async (name: string, ttl: number): Promise<Bucket> => {
			try {
				return await kvm.create(name, { ttl, replicas, history: 1 });
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
		};
		connected = true;
		options.onStatus?.("connected");
	})();
	// A failed first connect surfaces through `ready`; calls just see "not connected".
	ready.catch(() => undefined);

	function use(): { nodes: Bucket; claims: Bucket } {
		if (!buckets || !connected) throw new Error("NATS not connected");
		return buckets;
	}

	return {
		ready,
		board: {
			async advertise(node) {
				const advert = Advert.parse(node);
				await use().nodes.put(advert.id, JSON.stringify(advert));
			},
			async nodes() {
				const { nodes } = use();
				const found: MeshNode[] = [];
				for await (const key of await nodes.keys()) {
					const entry = await nodes.get(key);
					if (!entry || entry.operation !== "PUT") continue;
					let value: unknown;
					try {
						value = JSON.parse(entry.string());
					} catch {
						continue;
					}
					// An advertisement this version cannot read is a node it cannot rank.
					const advert = Advert.safeParse(value);
					if (advert.success && advert.data.id === key) found.push(advert.data);
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
		async close() {
			closing = true;
			connected = false;
			await disconnect?.();
		},
	};
}
