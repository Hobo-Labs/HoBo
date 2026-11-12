import { type Job, type Lease, memoryAdmitHeadroom } from "@hobo/ci";
import type { GithubTransport } from "../github.js";
import { getJob, rerunWorkflowRun } from "../github.js";
import { servedRunnerLabel, TRUNK_RUNNER_LABEL } from "../runner-labels.js";
import { type TrunkWaitCache, trunkWaitKey } from "../trunk-wait.js";
import type { WorkerMemoryAdmission } from "./memory-admission.js";
import { memoryRequestForStoredJob } from "./memory-classes.js";

export type HeadroomTrunkOverflowLog = (
	event: "hobo_ci_trunk_headroom_overflow",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type HeadroomTrunkOverflowStore = Readonly<{
	pendingJobs(): Promise<readonly Job[]>;
	activeLeases(): Promise<
		readonly Readonly<{
			id: string;
			repositoryId: number;
			jobId: number;
			runAttempt: number;
			state: string;
			sandboxName: string;
			sandboxSessionId: string;
			runnerId: number;
			hostRunId: number;
		}>[]
	>;
	transition(
		id: string,
		from: readonly string[],
		mutate: (lease: { state: string }) => void,
		event: string,
		at: string,
		revision: number,
	): Promise<Lease | undefined>;
	withdrawQueuedJob?(
		job: Job,
		at: string,
		revision: number,
	): Promise<boolean | undefined>;
}>;

export type { TrunkWaitCache } from "../trunk-wait.js";

const DEFAULT_OVERFLOW_AFTER_MS = 120_000;
const OVERFLOW_COOLDOWN_MS = 15 * 60_000;

export function createHeadroomTrunkOverflow(options: {
	github: GithubTransport;
	memoryAdmission: WorkerMemoryAdmission;
	availableMemoryMb: () => number | undefined;
	volatilityMb: number;
	overflowAfterMs?: number;
	now?: () => number;
	log?: HeadroomTrunkOverflowLog;
	cooldown?: Map<string, number>;
}) {
	const now = options.now ?? Date.now;
	const overflowAfterMs = options.overflowAfterMs ?? DEFAULT_OVERFLOW_AFTER_MS;
	const cooldown = options.cooldown ?? new Map<string, number>();
	if (
		!Number.isInteger(overflowAfterMs) ||
		overflowAfterMs < 0 ||
		overflowAfterMs > 900_000
	)
		throw new Error("invalid trunk headroom overflow window");

	async function overflowTrunkJobsWaitingForHeadroom(
		store: HeadroomTrunkOverflowStore,
		trunkWaits: TrunkWaitCache,
		reservationRevision: number,
		at: string,
	): Promise<number> {
		const availableMb = options.availableMemoryMb();
		const reserveMb = options.memoryAdmission.config.reserveMb;
		let overflowed = 0;
		const pending = await store.pendingJobs();
		for (const job of pending) {
			if (servedRunnerLabel(job.labels) !== TRUNK_RUNNER_LABEL) continue;
			const wait = trunkWaits.get(trunkWaitKey(job));
			if (!wait || now() - wait.sinceMs < overflowAfterMs) continue;
			const memory = memoryRequestForStoredJob(
				job,
				options.memoryAdmission.config,
			);
			if (
				memoryAdmitHeadroom(
					availableMb,
					memory.memoryMb,
					reserveMb,
					options.volatilityMb,
				)
			)
				continue;
			const cooldownKey = trunkWaitKey(job);
			const last = cooldown.get(cooldownKey);
			if (last !== undefined && now() - last < OVERFLOW_COOLDOWN_MS) continue;
			let current: Awaited<ReturnType<typeof getJob>>;
			try {
				current = await getJob(
					options.github,
					job.installationId,
					job.repository,
					job.id,
				);
			} catch {
				continue;
			}
			if (current.status !== "queued") {
				trunkWaits.delete(cooldownKey);
				continue;
			}
			if (servedRunnerLabel(current.labels) !== TRUNK_RUNNER_LABEL) continue;
			const active = await store.activeLeases();
			for (const lease of active) {
				if (
					lease.repositoryId !== job.repositoryId ||
					lease.jobId !== job.id ||
					lease.runAttempt !== job.runAttempt
				)
					continue;
				if (
					lease.sandboxName ||
					lease.sandboxSessionId ||
					lease.runnerId !== 0 ||
					lease.hostRunId !== 0
				)
					continue;
				if (lease.state !== "reserved") continue;
				await store.transition(
					lease.id,
					["reserved"],
					(entry) => {
						entry.state = "cancelled";
					},
					"ci.LeaseCancelled",
					at,
					reservationRevision,
				);
			}
			await store.withdrawQueuedJob?.(job, at, reservationRevision);
			const response = await rerunWorkflowRun(
				options.github,
				job.installationId,
				job.repository,
				job.runId,
			);
			if (!response.ok) continue;
			cooldown.set(cooldownKey, now());
			trunkWaits.delete(cooldownKey);
			overflowed += 1;
			options.log?.("hobo_ci_trunk_headroom_overflow", {
				repository: job.repository,
				runId: job.runId,
				jobId: job.id,
				runAttempt: job.runAttempt,
				waitedMs: now() - wait.sinceMs,
				requiredMb: memory.memoryMb,
				availableMb: availableMb ?? -1,
				reserveMb,
				volatilityMb: options.volatilityMb,
			});
		}
		return overflowed;
	}

	return { overflowTrunkJobsWaitingForHeadroom };
}
