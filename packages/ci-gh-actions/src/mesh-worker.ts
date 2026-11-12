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
	decayMeshReliability,
	type MeshBoard,
	type MeshCapacity,
	type MeshClaims,
	type MeshEvent,
	type MeshFree,
	type MeshMonitorEvent,
	type MeshNeeds,
	type MeshNode,
	type MeshPlatform,
	type MeshReliability,
	type MeshReliabilityOptions,
	type MeshReliabilitySamples,
	meshReliabilityScore,
	newMeshReliability,
	recordMeshOutcome,
	retractMeshDelivery,
} from "@hobo/ci/mesh";
import { createHealthSince } from "./mesh-node.js";
import { RUNNER_LABEL, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACE = /^[A-Za-z0-9_-]{1,32}$/;

export type MeshSettings = Readonly<{
	servers: readonly string[];
	nodeId: string;
	namespace: string;
	replicas: number;
	stepMs: number;
	/** How long until a job this worker took counts for half as much. */
	reliabilityHalfLifeMs: number;
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
		reliabilityHalfLifeMs: integer(
			"HOBO_CI_MESH_RELIABILITY_HALF_LIFE_MS",
			env.HOBO_CI_MESH_RELIABILITY_HALF_LIFE_MS,
			30 * 60_000,
			60_000,
			24 * 60 * 60_000,
		),
	};
}

export type WorkerMeshEvent =
	| MeshEvent
	| MeshMonitorEvent
	| "hobo_ci_mesh_job_taken"
	| "hobo_ci_mesh_job_unfit"
	| "hobo_ci_mesh_job_dropped"
	| "hobo_ci_mesh_reliability";

/** Why this worker counts a job it took as dropped. */
export type MeshDropReason =
	/** The job is still queued long after this worker claimed it. */
	| "never-started"
	/** Starting the runner failed repeatedly and the launch was given up. */
	| "launch-failed"
	/** The job's container was killed for using more memory than it had. */
	| "out-of-memory"
	/** The runner disappeared while the job was running. */
	| "runner-lost";

/**
 * What one of the worker's own log events says about a job it took. The
 * worker already reports each of these; nothing new has to be measured.
 */
function outcomeOf(event: string): "delivered" | MeshDropReason | undefined {
	switch (event) {
		case "hobo_ci_job_pickup":
			return "delivered";
		case "hobo_ci_launch_parked":
			return "launch-failed";
		case "hobo_ci_container_oom":
			return "out-of-memory";
		case "hobo_ci_orphan_job_confirmed":
			return "runner-lost";
		default:
			return undefined;
	}
}

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
	/**
	 * How long a job this worker claimed may stay queued before it counts as
	 * dropped. Only a job the poller still sees queued counts: one that left
	 * the queue some other way (cancelled, or taken elsewhere) is forgotten.
	 */
	startDeadlineMs?: number;
	/** Imaginary deliveries standing behind a worker with no history. */
	reliabilityPriorWeight?: number;
	/**
	 * The record this worker kept before it last stopped, read from its
	 * journal. It is decayed by the time the worker was down, like any other
	 * stretch. Left out, the worker starts with no history.
	 */
	initialReliability?: MeshReliability | undefined;
	/**
	 * Called with the record each time a job this worker took is counted, so
	 * it can be written to the journal. Its failures are the caller's to log;
	 * the worker does not wait for it.
	 */
	persistReliability?: (record: MeshReliability) => void;
	/**
	 * Rank only peers whose key the mesh's trust settings list, as they stand
	 * right now. Off when omitted: an unknown key is ranked as before.
	 */
	requireTrusted?: (() => boolean) | undefined;
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
	const startDeadlineMs = options.startDeadlineMs ?? 10 * 60_000;
	const scoring: MeshReliabilityOptions = {
		halfLifeMs: options.settings.reliabilityHalfLifeMs,
		priorWeight: options.reliabilityPriorWeight ?? 4,
	};
	// What became of the jobs this worker took. It starts from what the
	// journal kept, so a worker that crashes and restarts in a loop does not
	// begin each time with a clean record.
	let record = options.initialReliability ?? newMeshReliability(now());
	const since = createHealthSince(now);
	const persist = () => {
		try {
			options.persistReliability?.(record);
		} catch {
			// The record in memory is the one ranking uses; a failed write is
			// retried by the next job counted.
		}
	};
	/**
	 * Jobs claimed and not yet picked up by one of this worker's runners, with
	 * when each was claimed and when the poller last saw it queued.
	 */
	const claimed = new Map<number, { claimedAtMs: number; seenAtMs: number }>();
	// A queued job is seen on every poll; one unseen this long has left the queue.
	const forgetUnseenMs = Math.max(120_000, 3 * options.settings.stepMs);
	/** Jobs counted as delivered, by when; a runner can still be lost later. */
	const delivered = new Map<number, number>();
	/** Jobs already counted as dropped, so no second reason counts again. */
	const dropped = new Set<number>();
	const reliability = () => meshReliabilityScore(record, now(), scoring);
	// A record brought back from the journal is not news at start.
	let reportedScore =
		options.initialReliability === undefined ? 1 : reliability();
	/** The decayed counts behind the score, to two places. */
	const samples = (): MeshReliabilitySamples => {
		const current = decayMeshReliability(record, now(), scoring);
		return {
			delivered: Math.round(current.delivered * 100) / 100,
			dropped: Math.round(current.dropped * 100) / 100,
		};
	};
	// One line when the score has moved a twentieth since the last line.
	const reportScore = () => {
		const score = reliability();
		if (Math.abs(score - reportedScore) < 0.05) return;
		reportedScore = score;
		options.log?.("hobo_ci_mesh_reliability", {
			nodeId: options.settings.nodeId,
			reliability: Math.round(score * 1000) / 1000,
			delivered: Math.round(record.delivered * 100) / 100,
			dropped: Math.round(record.dropped * 100) / 100,
		});
	};
	const drop = (jobId: number, reason: MeshDropReason) => {
		if (dropped.has(jobId)) return;
		if (dropped.size >= 5000) dropped.clear();
		dropped.add(jobId);
		claimed.delete(jobId);
		const deliveredAtMs = delivered.get(jobId);
		delivered.delete(jobId);
		record =
			deliveredAtMs === undefined
				? recordMeshOutcome(record, "dropped", now(), scoring)
				: retractMeshDelivery(record, deliveredAtMs, now(), scoring);
		persist();
		options.log?.("hobo_ci_mesh_job_dropped", {
			jobId,
			reason,
			reliability: Math.round(reliability() * 1000) / 1000,
		});
		reportScore();
	};
	/** Forgets claims on jobs that left the queue, and deliveries long past. */
	const settle = () => {
		const at = now();
		// Cancelled, or started by another node: not this worker's drop.
		for (const [jobId, claim] of claimed)
			if (at - claim.seenAtMs >= forgetUnseenMs) claimed.delete(jobId);
		// Past eight half-lives a delivery counts for under half a percent.
		for (const [jobId, deliveredAtMs] of delivered)
			if (at - deliveredAtMs >= 8 * scoring.halfLifeMs) delivered.delete(jobId);
		reportScore();
	};
	const self = (): MeshNode => {
		const healthy = options.healthy();
		return {
			id: options.settings.nodeId,
			freeSlots: Math.max(0, Math.floor(options.freeSlots())),
			totalSlots: options.totalSlots,
			healthy,
			labels,
			validUntilMs: now() + advertTtlMs,
			free: options.free?.(),
			platform: options.platform,
			reliability: reliability(),
			samples: samples(),
			sinceMs: since(healthy),
		};
	};
	const coordinator = createMeshCoordinator({
		self,
		board: options.board,
		claims: options.claims,
		stepMs: options.settings.stepMs,
		requireTrusted: options.requireTrusted,
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
		advertise: () => {
			settle();
			return coordinator.advertise();
		},
		/** This worker as it advertises itself right now, unsigned. */
		self,
		/** The share of its recent jobs this worker delivered, in (0, 1]. */
		reliability,
		/** The decayed counts that share is computed from. */
		samples,
		/**
		 * Feed the worker's own log events here. The ones that say what became
		 * of a job this worker claimed move its reliability; the rest are
		 * ignored, as is any event about a job it did not claim.
		 */
		record(
			event: string,
			fields: Readonly<Record<string, string | number | boolean>>,
		): void {
			const outcome = outcomeOf(event);
			const jobId = fields.jobId;
			if (outcome === undefined || !Number.isSafeInteger(jobId)) return;
			if (outcome !== "delivered") {
				// A drop counts only for a job this worker took through the mesh.
				if (claimed.has(Number(jobId)) || delivered.has(Number(jobId)))
					drop(Number(jobId), outcome);
				return;
			}
			if (!claimed.delete(Number(jobId))) return;
			delivered.set(Number(jobId), now());
			record = recordMeshOutcome(record, "delivered", now(), scoring);
			persist();
			reportScore();
		},
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
				// From here the job is this worker's to deliver or drop.
				if (!dropped.has(job.jobId) && !delivered.has(job.jobId))
					claimed.set(job.jobId, { claimedAtMs: now(), seenAtMs: now() });
				options.log?.("hobo_ci_mesh_job_taken", {
					jobId: job.jobId,
					runId: job.runId,
					rank: decision.rank,
					reason: decision.reason,
				});
			}
			// Still queued, and still this worker's: note it was seen, and count
			// it as dropped once it has waited past the deadline.
			const claim = claimed.get(job.jobId);
			if (decision.start && claim) {
				claim.seenAtMs = now();
				if (now() - claim.claimedAtMs >= startDeadlineMs)
					drop(job.jobId, "never-started");
			}
			return decision.start;
		},
	};
}

export type WorkerMesh = ReturnType<typeof createWorkerMesh>;
