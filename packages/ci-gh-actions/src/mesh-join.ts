import { readFileSync } from "node:fs";
import { createNatsMesh, type NatsMesh } from "./mesh-nats.js";
import {
	createMeshNode,
	loadMeshIdentity,
	type MeshNodeDescription,
	type MeshNodeEvent,
	type MeshNodeHandle,
} from "./mesh-node.js";
import { type MeshSettings, meshSettingsFromEnv } from "./mesh-worker.js";

type Env = Readonly<Record<string, string | undefined>>;

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
	settings: MeshSettings | undefined;
	start(): void;
	beat(): Promise<void>;
	stop(): Promise<void>;
}>;

export async function joinMeshFromEnv(options: {
	env: Env;
	defaultNodeId: string;
	keyFile: string;
	connectionName: string;
	describe: () => MeshNodeDescription;
	beatMs?: number;
	advertTtlMs?: number | undefined;
	afterBeat?: (node: MeshNodeHandle) => Promise<void>;
	log?:
		| ((
				event:
					| MeshNodeEvent
					| "hobo_ci_mesh_nats"
					| "hobo_ci_mesh_nodes_capped",
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
				onNodesCapped: (limit) =>
					options.log?.("hobo_ci_mesh_nodes_capped", { limit }),
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
		} catch {}
	};
	return {
		node,
		settings,
		beat,
		start() {
			if (timer) return;
			timer = setInterval(() => void beat(), options.beatMs ?? 10_000);
			timer.unref();
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
