/**
 * Reruns main-gate jobs still bound to an offline peer box JIT after witness
 * deregister — never cancels a workflow run or touches foreign/ARC runners.
 */

import {
	type GithubTransport,
	getJob,
	getRun,
	rerunWorkflowJob,
} from "./github.js";
import {
	parseRunCreatedAtMs,
	type StallJobRerunPolicy,
	stallJobRerunAllowed,
} from "./isolated-worker/stall-job-recovery.js";

export type OfflineJitRecoveryEvent =
	| "hobo_ci_offline_jit_job_recovery_registered"
	| "hobo_ci_offline_jit_job_rerun"
	| "hobo_ci_offline_jit_job_annotated"
	| "hobo_ci_offline_jit_job_rerun_skipped"
	| "hobo_ci_offline_jit_job_recovery_dropped";

export type OfflineJitRecoveryLog = (
	event: OfflineJitRecoveryEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type OfflineJitRecoveryRecord = Readonly<{
	repository: string;
	installationId: number;
	runId: number;
	jobId: number;
	runnerName: string;
	leaseId: string;
	recoveryRole: "minting_host" | "fleet_witness";
	registeredAtMs: number;
}>;

const DEFAULT_MAIN_BRANCH = "main";
const DEFAULT_RERUN_WINDOW_MS = 15 * 60_000;
const MAX_RECORDS = 200;

function recordKey(record: OfflineJitRecoveryRecord): string {
	return `${record.repository}:${record.jobId}`;
}

function recordFields(record: OfflineJitRecoveryRecord) {
	return {
		repository: record.repository,
		runId: record.runId,
		jobId: record.jobId,
		runnerName: record.runnerName,
		leaseId: record.leaseId,
		recoveryRole: record.recoveryRole,
	};
}

export function createOfflineJitJobRecovery(options: {
	github: GithubTransport;
	now?: () => number;
	log?: OfflineJitRecoveryLog;
	mainBranch?: string;
	rerunWindowMs?: number;
}) {
	const now = options.now ?? Date.now;
	const mainBranch = options.mainBranch ?? DEFAULT_MAIN_BRANCH;
	const rerunWindowMs = options.rerunWindowMs ?? DEFAULT_RERUN_WINDOW_MS;
	const active = new Map<
		string,
		OfflineJitRecoveryRecord & { jobRerunDone: boolean }
	>();
	const retired = new Set<string>();

	function drop(record: OfflineJitRecoveryRecord, reason: string): void {
		active.delete(recordKey(record));
		retired.add(recordKey(record));
		options.log?.("hobo_ci_offline_jit_job_recovery_dropped", {
			...recordFields(record),
			reason,
		});
	}

	function register(record: OfflineJitRecoveryRecord): void {
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
			"hobo_ci_offline_jit_job_recovery_registered",
			recordFields(record),
		);
	}

	async function applyRerunPolicy(
		record: OfflineJitRecoveryRecord & { jobRerunDone: boolean },
		policy: StallJobRerunPolicy,
		run: { event: string; head_branch: string | null },
	): Promise<void> {
		if (!policy.allowed) {
			if (run.event === "pull_request") {
				options.log?.("hobo_ci_offline_jit_job_annotated", {
					...recordFields(record),
					event: run.event,
					headBranch: run.head_branch ?? "",
					message:
						"Job was bound to an offline peer box runner; workflow was not cancelled. Re-run this job manually if needed.",
				});
			} else {
				options.log?.("hobo_ci_offline_jit_job_rerun_skipped", {
					...recordFields(record),
					event: run.event,
					headBranch: run.head_branch ?? "",
					message: policy.reason,
				});
			}
			drop(record, policy.reason);
			return;
		}
		if (record.jobRerunDone) {
			drop(record, "already-rerun");
			return;
		}
		const response = await rerunWorkflowJob(
			options.github,
			record.installationId,
			record.repository,
			record.jobId,
		);
		record.jobRerunDone = true;
		options.log?.("hobo_ci_offline_jit_job_rerun", {
			...recordFields(record),
			event: run.event,
			status: response.status,
		});
		if (response.status === 201) drop(record, "rerun-requested");
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
				await applyRerunPolicy(record, policy, run);
			} catch {
				/* transient GitHub read */
			}
		}
	}

	return { register, reconcile };
}

export type OfflineJitJobRecovery = ReturnType<
	typeof createOfflineJitJobRecovery
>;
