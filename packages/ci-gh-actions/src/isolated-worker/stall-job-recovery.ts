/**
 * Host-stall recovery for jobs on this box worker only.
 *
 * Stops the local container only — never force-cancels a workflow run and never
 * touches ARC or GitHub-hosted runners. Single-job rerun is limited to main
 * push and merge_group within a short window after run creation.
 */

import type { Lease } from "@hobo/ci";
import {
	type GithubTransport,
	getJob,
	getRun,
	rerunWorkflowJob,
} from "../github.js";
import type { ContainerStallSignal } from "./host-resource-pressure.js";

export type StallJobRecoveryEvent =
	| "hobo_ci_stall_job_recovery_registered"
	| "hobo_ci_stall_job_annotated"
	| "hobo_ci_stall_job_rerun"
	| "hobo_ci_stall_job_rerun_skipped"
	| "hobo_ci_stall_job_recovery_dropped";

export type StallJobRecoveryLog = (
	event: StallJobRecoveryEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type StallRecoveryRecord = Readonly<{
	repository: string;
	installationId: number;
	runId: number;
	jobId: number;
	runnerName: string;
	stallReason: string;
	registeredAtMs: number;
}>;

const DEFAULT_MAIN_BRANCH = "main";
const DEFAULT_RERUN_WINDOW_MS = 15 * 60_000;
const MAX_RECORDS = 200;

export function stallRecoveryRecordForLease(
	lease: Lease,
	signal: ContainerStallSignal,
	registeredAtMs: number,
): StallRecoveryRecord {
	return {
		repository: lease.repository,
		installationId: lease.installationId,
		runId: lease.originalRunId,
		jobId: lease.actualJobId > 0 ? lease.actualJobId : lease.jobId,
		runnerName: lease.runnerName,
		stallReason: signal.reason,
		registeredAtMs,
	};
}

function recordKey(record: StallRecoveryRecord): string {
	return `${record.repository}:${record.jobId}`;
}

function recordFields(record: StallRecoveryRecord) {
	return {
		repository: record.repository,
		runId: record.runId,
		jobId: record.jobId,
		runnerName: record.runnerName,
		stallReason: record.stallReason,
	};
}

export function parseRunCreatedAtMs(run: {
	created_at?: string | undefined;
	run_started_at: string | null;
}): number | undefined {
	const raw = run.created_at ?? run.run_started_at;
	if (!raw) return undefined;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export type StallJobRerunPolicy = Readonly<{
	allowed: boolean;
	reason: string;
}>;

export function stallJobRerunAllowed(
	run: {
		event: string;
		head_branch: string | null;
	},
	mainBranch: string,
	runCreatedAtMs: number | undefined,
	nowMs: number,
	rerunWindowMs: number,
): StallJobRerunPolicy {
	if (run.event === "pull_request") {
		return {
			allowed: false,
			reason: "pull_request runs are never auto-rerun after stall",
		} satisfies StallJobRerunPolicy;
	}
	const mainGate =
		run.event === "merge_group" ||
		(run.event === "push" && run.head_branch === mainBranch);
	if (!mainGate) {
		return {
			allowed: false,
			reason: "event is not main push or merge_group",
		} satisfies StallJobRerunPolicy;
	}
	if (runCreatedAtMs === undefined) {
		return {
			allowed: false,
			reason: "run creation time unknown",
		} satisfies StallJobRerunPolicy;
	}
	if (nowMs - runCreatedAtMs > rerunWindowMs) {
		return {
			allowed: false,
			reason: "outside stall rerun window",
		} satisfies StallJobRerunPolicy;
	}
	return { allowed: true, reason: "" } satisfies StallJobRerunPolicy;
}

export function createStallJobRecovery(options: {
	github: GithubTransport;
	now?: () => number;
	log?: StallJobRecoveryLog;
	mainBranch?: string;
	rerunWindowMs?: number;
}) {
	const now = options.now ?? Date.now;
	const mainBranch = options.mainBranch ?? DEFAULT_MAIN_BRANCH;
	const rerunWindowMs = options.rerunWindowMs ?? DEFAULT_RERUN_WINDOW_MS;
	const active = new Map<
		string,
		StallRecoveryRecord & { jobRerunDone: boolean }
	>();
	const retired = new Set<string>();

	function drop(record: StallRecoveryRecord, reason: string): void {
		active.delete(recordKey(record));
		retired.add(recordKey(record));
		options.log?.("hobo_ci_stall_job_recovery_dropped", {
			...recordFields(record),
			reason,
		});
	}

	function register(record: StallRecoveryRecord): void {
		const key = recordKey(record);
		if (active.has(key) || retired.has(key)) return;
		while (active.size >= MAX_RECORDS) {
			const oldest = active.keys().next().value;
			if (oldest === undefined) break;
			const victim = active.get(oldest);
			if (victim) drop(victim, "capacity");
			else active.delete(oldest);
		}
		active.set(key, { ...record, jobRerunDone: false });
		options.log?.(
			"hobo_ci_stall_job_recovery_registered",
			recordFields(record),
		);
	}

	async function reconcile(): Promise<void> {
		for (const record of active.values()) {
			try {
				const job = await getJob(
					options.github,
					record.installationId,
					record.repository,
					record.jobId,
				);
				if (job.status === "queued") {
					drop(record, "queued");
					continue;
				}
				if (
					job.status === "in_progress" &&
					(job.runner_name ?? "") === record.runnerName
				)
					continue;
				if (job.status !== "completed") continue;

				const run = await getRun(
					options.github,
					record.installationId,
					record.repository,
					job.run_id,
				);
				const runCreatedAtMs = parseRunCreatedAtMs(run);
				const policy = stallJobRerunAllowed(
					run,
					mainBranch,
					runCreatedAtMs,
					now(),
					rerunWindowMs,
				);

				if (!policy.allowed) {
					if (run.event === "pull_request") {
						options.log?.("hobo_ci_stall_job_annotated", {
							...recordFields(record),
							event: run.event,
							headBranch: run.head_branch ?? "",
							message:
								"Host stall stopped this box worker; workflow was not cancelled. Re-run this job manually if needed.",
						});
					} else {
						options.log?.("hobo_ci_stall_job_rerun_skipped", {
							...recordFields(record),
							event: run.event,
							headBranch: run.head_branch ?? "",
							message: policy.reason,
						});
					}
					drop(record, policy.reason);
					continue;
				}

				if (record.jobRerunDone) {
					drop(record, "already-rerun");
					continue;
				}

				const response = await rerunWorkflowJob(
					options.github,
					record.installationId,
					record.repository,
					record.jobId,
				);
				record.jobRerunDone = true;
				options.log?.("hobo_ci_stall_job_rerun", {
					...recordFields(record),
					event: run.event,
					status: response.status,
				});
				if (response.status === 201) drop(record, "rerun-requested");
			} catch {}
		}
	}

	return { register, reconcile };
}

export type StallJobRecovery = ReturnType<typeof createStallJobRecovery>;
