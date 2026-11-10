/**
 * The box worker's side of the relay mesh: read its settings, and turn the
 * poller's "may I take this queued job?" into a mesh decision.
 *
 * The mesh is off unless `HOBO_CI_NATS_URL` is set. Off, a worker takes every
 * job it polls, as it always has. On, it advertises its free slots and takes
 * a job only when it is its turn and it wins the claim; if NATS cannot be
 * reached it still takes its turn by ranking, so the queue never waits on NATS.
 */
import {
	createMeshCoordinator,
	createMeshMonitor,
	type MeshBoard,
	type MeshCapacity,
	type MeshClaims,
	type MeshEvent,
	type MeshFree,
	type MeshMonitorEvent,
	type MeshNeeds,
	type MeshPlatform,
} from "@hobo/ci/mesh";
import { RUNNER_LABEL, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACE = /^[A-Za-z0-9_-]{1,32}$/;

export type MeshSettings = Readonly<{
	servers: readonly string[];
	nodeId: string;
	namespace: string;
	replicas: number;
	stepMs: number;
}>;

function integer(
	name: string,
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || parsed < min || parsed > max)
		throw new Error(`invalid ${name}: expected an integer ${min} to ${max}`);
	return parsed;
}

/**
 * The mesh settings in `env`, or `undefined` when no NATS server is named.
 * A host name becomes the node id with every other character replaced, so a
 * worker needs no extra setting to join; two workers on one host need
 * `HOBO_CI_MESH_NODE_ID` to tell them apart.
 */
export function meshSettingsFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	hostname: string,
): MeshSettings | undefined {
	const servers = (env.HOBO_CI_NATS_URL ?? "")
		.split(",")
		.map((server) => server.trim())
		.filter((server) => server !== "");
	if (servers.length === 0) return undefined;
	for (const server of servers) {
		let url: URL;
		try {
			url = new URL(server);
		} catch {
			throw new Error("invalid HOBO_CI_NATS_URL: expected nats://host:port");
		}
		if (!["nats:", "tls:", "ws:", "wss:"].includes(url.protocol))
			throw new Error("invalid HOBO_CI_NATS_URL: expected nats://host:port");
		// Credentials go in HOBO_CI_NATS_TOKEN or _USER/_PASSWORD, where they
		// are not logged with the server list.
		if (url.username || url.password)
			throw new Error("HOBO_CI_NATS_URL must not carry credentials");
	}
	const nodeId =
		env.HOBO_CI_MESH_NODE_ID ??
		hostname.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
	if (!NODE_ID.test(nodeId))
		throw new Error("invalid HOBO_CI_MESH_NODE_ID: letters, digits, - and _");
	const namespace = env.HOBO_CI_MESH_NAMESPACE ?? "hobo-ci";
	if (!NAMESPACE.test(namespace))
		throw new Error("invalid HOBO_CI_MESH_NAMESPACE: letters, digits, - and _");
	return {
		servers,
		nodeId,
		namespace,
		replicas: integer(
			"HOBO_CI_NATS_REPLICAS",
			env.HOBO_CI_NATS_REPLICAS,
			1,
			1,
			5,
		),
		stepMs: integer(
			"HOBO_CI_MESH_STEP_MS",
			env.HOBO_CI_MESH_STEP_MS,
			20_000,
			1_000,
			300_000,
		),
	};
}

export type WorkerMeshEvent =
	| MeshEvent
	| MeshMonitorEvent
	| "hobo_ci_mesh_job_taken"
	| "hobo_ci_mesh_job_unfit";

export function createWorkerMesh(options: {
	settings: MeshSettings;
	board: MeshBoard;
	claims: MeshClaims;
	/** Runner slots not in use right now. */
	freeSlots: () => number;
	/** All runner slots this worker has, for the mesh's capacity figures. */
	totalSlots: number;
	/** False while draining or under host pressure: others stop deferring to this node. */
	healthy: () => boolean;
	/** True when this worker also starts trunk-label runners. */
	servesTrunk: boolean;
	/**
	 * What this worker has free besides slots (memory it could give a new job
	 * right now). Left out, the worker is ranked by free slots alone.
	 */
	free?: () => MeshFree;
	/** What this worker runs on, for jobs that need a particular platform. */
	platform?: MeshPlatform;
	/**
	 * What a queued job needs, from what the poller knows about it. Left out,
	 * or returning nothing, the job fits any worker with a free slot.
	 */
	needs?: (job: { name: string; label: string }) => MeshNeeds | undefined;
	/** How long an advertisement is trusted; refresh well inside it. */
	advertTtlMs?: number;
	now?: () => number;
	log?: (
		event: WorkerMeshEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	const now = options.now ?? Date.now;
	const advertTtlMs = options.advertTtlMs ?? 45_000;
	const labels = options.servesTrunk
		? [RUNNER_LABEL, TRUNK_RUNNER_LABEL]
		: [RUNNER_LABEL];
	const coordinator = createMeshCoordinator({
		self: () => ({
			id: options.settings.nodeId,
			freeSlots: Math.max(0, Math.floor(options.freeSlots())),
			totalSlots: options.totalSlots,
			healthy: options.healthy(),
			labels,
			validUntilMs: now() + advertTtlMs,
			free: options.free?.(),
			platform: options.platform,
		}),
		board: options.board,
		claims: options.claims,
		stepMs: options.settings.stepMs,
		now,
		log: (event, fields) => options.log?.(event, fields),
	});
	const monitor = createMeshMonitor({
		selfId: options.settings.nodeId,
		board: options.board,
		now,
		log: (event, fields) => options.log?.(event, fields),
	});
	// One line per job taken, not one per poll that sees it.
	const reported = new Set<number>();
	// One line per job and reason this worker could not fit, for the same reason.
	const unfit = new Set<string>();

	return {
		advertise: () => coordinator.advertise(),
		/**
		 * Reads the board and reports what changed: nodes joining, going
		 * unhealthy or disappearing, and the mesh running out of free slots.
		 */
		observe: (): Promise<MeshCapacity | undefined> => monitor.observe(),
		/** The poller's gate: whether this worker takes a queued job now. */
		async claim(job: {
			jobId: number;
			runId: number;
			label: string;
			/** The job's name, which is what its size is known by. */
			name?: string | undefined;
			createdAt: string | undefined;
		}): Promise<boolean> {
			const created = Date.parse(job.createdAt ?? "");
			const needs =
				job.name === undefined
					? undefined
					: options.needs?.({ name: job.name, label: job.label });
			const decision = await coordinator.shouldStart({
				jobId: job.jobId,
				label: job.label,
				// No queue time in the list: treat the job as queued just now.
				queuedAtMs: Number.isFinite(created) ? created : now(),
				needs,
			});
			// A worker with a free slot that still cannot take the job says why:
			// "no memory for this job" is a different problem from "no slot".
			if (
				!decision.start &&
				decision.reason === "not-eligible" &&
				decision.lacking !== "slots"
			) {
				const key = `${job.jobId}:${decision.lacking}`;
				if (!unfit.has(key)) {
					if (unfit.size >= 5000) unfit.clear();
					unfit.add(key);
					options.log?.("hobo_ci_mesh_job_unfit", {
						jobId: job.jobId,
						runId: job.runId,
						lacking: decision.lacking,
						needsMemoryMb: needs?.memoryMb ?? 0,
						freeMemoryMb: options.free?.().memoryMb ?? 0,
					});
				}
			}
			if (decision.start && !reported.has(job.jobId)) {
				if (reported.size >= 5000) reported.clear();
				reported.add(job.jobId);
				options.log?.("hobo_ci_mesh_job_taken", {
					jobId: job.jobId,
					runId: job.runId,
					rank: decision.rank,
					reason: decision.reason,
				});
			}
			return decision.start;
		},
	};
}

export type WorkerMesh = ReturnType<typeof createWorkerMesh>;
