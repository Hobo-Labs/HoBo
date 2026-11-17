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

export type MeshDropReason =
	| "never-started"
	| "launch-failed"
	| "out-of-memory"
	| "runner-lost";

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
	freeSlots: () => number;
	totalSlots: number;
	healthy: () => boolean;
	servesTrunk: boolean;
	free?: () => MeshFree;
	platform?: MeshPlatform;
	needs?: (job: { name: string; label: string }) => MeshNeeds | undefined;
	advertTtlMs?: number;
	startDeadlineMs?: number;
	reliabilityPriorWeight?: number;
	initialReliability?: MeshReliability | undefined;
	persistReliability?: (record: MeshReliability) => void;
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
	let record = options.initialReliability ?? newMeshReliability(now());
	const since = createHealthSince(now);
	const persist = () => {
		try {
			options.persistReliability?.(record);
		} catch {}
	};
	const claimed = new Map<number, { claimedAtMs: number; seenAtMs: number }>();
	const forgetUnseenMs = Math.max(120_000, 3 * options.settings.stepMs);
	const delivered = new Map<number, number>();
	const dropped = new Set<number>();
	const reliability = () => meshReliabilityScore(record, now(), scoring);
	let reportedScore =
		options.initialReliability === undefined ? 1 : reliability();
	const samples = (): MeshReliabilitySamples => {
		const current = decayMeshReliability(record, now(), scoring);
		return {
			delivered: Math.round(current.delivered * 100) / 100,
			dropped: Math.round(current.dropped * 100) / 100,
		};
	};
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
	const settle = () => {
		const at = now();
		for (const [jobId, claim] of claimed)
			if (at - claim.seenAtMs >= forgetUnseenMs) claimed.delete(jobId);
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
	const reported = new Set<number>();
	const unfit = new Set<string>();

	return {
		advertise: () => {
			settle();
			return coordinator.advertise();
		},
		self,
		reliability,
		samples,
		record(
			event: string,
			fields: Readonly<Record<string, string | number | boolean>>,
		): void {
			const outcome = outcomeOf(event);
			const jobId = fields.jobId;
			if (outcome === undefined || !Number.isSafeInteger(jobId)) return;
			if (outcome !== "delivered") {
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
		observe: (): Promise<MeshCapacity | undefined> => monitor.observe(),
		async claim(job: {
			jobId: number;
			runId: number;
			label: string;
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
				queuedAtMs: Number.isFinite(created) ? created : now(),
				needs,
			});
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
				if (!dropped.has(job.jobId) && !delivered.has(job.jobId))
					claimed.set(job.jobId, { claimedAtMs: now(), seenAtMs: now() });
				options.log?.("hobo_ci_mesh_job_taken", {
					jobId: job.jobId,
					runId: job.runId,
					rank: decision.rank,
					reason: decision.reason,
				});
			}
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
