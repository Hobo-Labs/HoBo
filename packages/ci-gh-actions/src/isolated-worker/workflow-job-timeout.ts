import { capIsolatedContainerTimeoutMs } from "./container-timeout.js";

/** GitHub `timeout-minutes` for jobs where routing `reservedMinutes` can underestimate. */
const WORKFLOW_JOB_TIMEOUT_MINUTES = new Map<string, number>([
	["Main full gate", 20],
	["Main workspace plan", 12],
	["CI deps layer (pnpm)", 20],
	["CI fabric contract guard", 20],
	["Release contract + affected OCI images", 20],
	["Build all OCI images on tag (gate publish)", 20],
	["Publish GHCR images (tagged release)", 20],
	["Main train release gate (nbgv)", 20],
]);

const MAIN_WORKSPACE_SHARD = /^Main workspace test shard \d+$/u;

export function workflowJobTimeoutMinutes(
	jobName: string | undefined,
): number | undefined {
	if (!jobName) return undefined;
	const exact = WORKFLOW_JOB_TIMEOUT_MINUTES.get(jobName);
	if (exact !== undefined) return exact;
	if (MAIN_WORKSPACE_SHARD.test(jobName)) return 20;
	if (jobName.includes("Build and verify release image")) return 20;
	return undefined;
}

export function effectiveIsolatedTimeoutMs(
	reservedMinutes: number,
	jobName: string | undefined,
): number {
	const reserved =
		Number.isFinite(reservedMinutes) && reservedMinutes > 0
			? Math.ceil(reservedMinutes)
			: 1;
	const workflowMinutes = workflowJobTimeoutMinutes(jobName);
	const minutes = Math.max(reserved, workflowMinutes ?? reserved);
	return capIsolatedContainerTimeoutMs(minutes * 60_000);
}
