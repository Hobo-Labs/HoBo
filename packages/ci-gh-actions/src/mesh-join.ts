/**
 * Joins the mesh the environment names, as a node that takes no jobs through
 * it: a relay host, or a developer's machine running jobs for one repository.
 *
 * `HOBO_CI_NATS_URL` names the mesh, exactly as it does for a box worker.
 * Without it the node is offline: it has an identity and reports itself, and
 * advertises nowhere. The NATS client is loaded only when a server is named.
 */
import { readFileSync } from "node:fs";
import { createNatsMesh, type NatsMesh } from "./mesh-nats.js";
import {
	createMeshNode,
	loadMeshIdentity,
	type MeshNodeEvent,
	type MeshNodeHandle,
	type MeshNodeDescription,
} from "./mesh-node.js";
import { type MeshSettings, meshSettingsFromEnv } from "./mesh-worker.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Optional NATS credentials, from the variable or its `_FILE`. */
export function natsCredentialsFromEnv(env: Env) {
	const read = (name: string) => {
		const file = env[`${name}_FILE`];
		const value = file ? readFileSync(file, "utf8").trimEnd() : env[name];
		return value ? value : undefined;
	};
	return {
		token: read("HOBO_CI_NATS_TOKEN"),
		user: read("HOBO_CI_NATS_USER"),
		password: read("HOBO_CI_NATS_PASSWORD"),
	};
}

/**
 * The id a node has when `HOBO_CI_MESH_NODE_ID` does not name one: the
 * fallback with every character a node id cannot hold replaced.
 */
export function meshNodeIdFromEnv(env: Env, fallback: string): string {
	const nodeId =
		env.HOBO_CI_MESH_NODE_ID ??
		fallback.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(nodeId))
		throw new Error("invalid HOBO_CI_MESH_NODE_ID: letters, digits, - and _");
	return nodeId;
}

export type JoinedMesh = Readonly<{
	node: MeshNodeHandle;
	/** The mesh settings in force, or nothing when the node is offline. */
	settings: MeshSettings | undefined;
	/** Start advertising: once NATS is up, then on every beat. */
	start(): void;
	/** One beat now; resolves when it has been tried. */
	beat(): Promise<void>;
	/** Advertise one last time (a node that is stopping says so), then disconnect. */
	stop(): Promise<void>;
}>;

export async function joinMeshFromEnv(options: {
	env: Env;
	/** The node id when the environment names none, for example `relay-<host>`. */
	defaultNodeId: string;
	/** Where the node's private identity key is kept, readable by its owner only. */
	keyFile: string;
	/** Shown in the NATS server's connection list. */
	connectionName: string;
	describe: () => MeshNodeDescription;
	beatMs?: number;
	advertTtlMs?: number | undefined;
	/** Called after each beat, for a node that also keeps a local report. */
	afterBeat?: (node: MeshNodeHandle) => Promise<void>;
	log?:
		| ((
				event: MeshNodeEvent | "hobo_ci_mesh_nats",
				fields: Readonly<Record<string, string | number | boolean>>,
		  ) => void)
		| undefined;
}): Promise<JoinedMesh> {
	const nodeId = meshNodeIdFromEnv(options.env, options.defaultNodeId);
	const settings = meshSettingsFromEnv(options.env, nodeId);
	const identity = await loadMeshIdentity(options.keyFile);
	const nats: NatsMesh | undefined = settings
		? createNatsMesh({
				servers: settings.servers,
				namespace: settings.namespace,
				replicas: settings.replicas,
				name: options.connectionName,
				onStatus: (status) => options.log?.("hobo_ci_mesh_nats", { status }),
				...natsCredentialsFromEnv(options.env),
			})
		: undefined;
	const node = createMeshNode({
		nodeId,
		identity,
		mesh: nats && { board: nats.board, trust: nats.trust },
		describe: options.describe,
		advertTtlMs: options.advertTtlMs,
		log: options.log,
	});
	let timer: ReturnType<typeof setInterval> | undefined;
	const beat = async () => {
		await node.beat();
		try {
			await options.afterBeat?.(node);
		} catch {
			// A local report that cannot be written does not stop the node.
		}
	};
	return {
		node,
		settings,
		beat,
		start() {
			if (timer) return;
			timer = setInterval(() => void beat(), options.beatMs ?? 10_000);
			timer.unref();
			// The first connection is made in the background; advertise as soon
			// as it is up, and at once when there is nothing to connect to.
			if (!nats) void beat();
			else
				nats.ready.then(
					() => void beat(),
					(error) =>
						options.log?.("hobo_ci_mesh_nats", {
							status: "failed",
							message: error instanceof Error ? error.message : "unknown",
						}),
				);
		},
		async stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
			await beat();
			await Promise.race([
				nats?.close().catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
			]);
		},
	};
}
