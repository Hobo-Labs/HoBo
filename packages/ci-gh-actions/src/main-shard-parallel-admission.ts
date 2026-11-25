import type { Job } from "@hobo/ci";
import { memoryAdmitParallelCount } from "@hobo/ci";
import {
	isMainWorkspaceShardJob,
	mainWorkspaceShardIndex,
} from "./admission-order.js";
import type { TrunkWaitReason } from "./trunk-wait.js";

export type MainShardParallelCapacityInput = Readonly<{
	availableMb?: number;
	requestMb: number;
	reserveMb: number;
	volatilityMb: number;
	launchSlots: number;
}>;

export function mainShardParallelLaunchCapacity(
	input: MainShardParallelCapacityInput,
): number {
	return memoryAdmitParallelCount(
		input.availableMb,
		input.requestMb,
		input.reserveMb,
		input.volatilityMb,
		input.launchSlots,
	);
}

/** Convert memory-parallel admits into total box launch slots (live + additional). */
export function effectiveParallelLaunchSlots(
	policyLaunchSlots: number,
	liveContainerCount: number,
	additionalMemoryParallelCap: number | undefined,
): number {
	if (additionalMemoryParallelCap === undefined) return policyLaunchSlots;
	return Math.min(
		policyLaunchSlots,
		liveContainerCount + Math.max(0, additionalMemoryParallelCap),
	);
}

export type MainShardAdmissionHoldFields = Readonly<
	Record<string, string | number | boolean>
>;

export function logMainShardAdmissionHold(
	job: Pick<Job, "repository" | "runId" | "id" | "name" | "runAttempt">,
	reason: TrunkWaitReason | MemoryAdmissionHoldReason,
	fields: MainShardAdmissionHoldFields = {},
): void {
	if (!isMainWorkspaceShardJob(job.name)) return;
	const shardIndex = mainWorkspaceShardIndex(job.name);
	const core = {
		event: "hobo_ci_main_shard_admission_hold" as const,
		repository: job.repository,
		runId: job.runId,
		jobId: job.id,
		runAttempt: job.runAttempt,
		jobName: job.name ?? "",
		reason,
	};
	const payload =
		shardIndex === undefined
			? { ...core, ...fields }
			: { ...core, shardIndex, ...fields };
	console.error(JSON.stringify(payload));
}

export type MemoryAdmissionHoldReason =
	| "memory-budget"
	| "memory-headroom"
	| "host-available"
	| "host-pressure"
	| "cpu-contention"
	| "trunk-pr-cap";
