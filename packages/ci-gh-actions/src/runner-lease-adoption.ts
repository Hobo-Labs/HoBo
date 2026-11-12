import { create } from "@bufbuild/protobuf";
import { ACTIVE_STATES, JobSchema, type Lease } from "@hobo/ci";
import type { GithubTransport } from "./github.js";
import type { HostedRelayStore } from "./hosted-relay.js";
import {
	type ResolvedRunnerAssignment,
	resolveRunnerAssignedJob,
	runnerHoldsActiveJob,
} from "./jit-runner-correlation.js";
import { RUNNER_LABEL } from "./runner-labels.js";

export type RunnerCustodyAdoption = Readonly<{
	lease: Lease;
	assignment?: ResolvedRunnerAssignment;
	holdsActive: boolean;
}>;

function reservedJobWithdraw(lease: Lease) {
	return create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		memoryClass: lease.memoryClass,
		memoryMb: lease.memoryMb,
		labels: [RUNNER_LABEL],
		action: "queued",
		isolatedRequired: true,
	});
}

/** Pin `actualJobId` / `originalRunId` to the job GitHub assigned this runner. */
export async function adoptRunnerAssignment(
	store: Pick<HostedRelayStore, "get" | "transition" | "withdrawQueuedJob">,
	github: GithubTransport,
	lease: Lease,
	at: string,
	log?: (
		event: "hobo_ci_jit_runner_custody_transferred",
		fields: Readonly<Record<string, string | number>>,
	) => void,
): Promise<RunnerCustodyAdoption> {
	if (!lease.runnerName) return { lease, holdsActive: false };
	const reservedJobId = lease.jobId;
	const reservedRunId = lease.originalRunId;
	let assignment: ResolvedRunnerAssignment | undefined;
	try {
		assignment = await resolveRunnerAssignedJob(
			github,
			lease.installationId,
			lease.repository,
			lease.runnerName,
			lease.runnerId,
			{
				reservedJobId: lease.jobId,
				preferRunIds: [lease.originalRunId],
			},
		);
	} catch {
		return { lease, holdsActive: false };
	}
	const holdsActive = runnerHoldsActiveJob(assignment);
	if (!assignment) return { lease, holdsActive: false };
	const servedJobId = assignment.jobId;
	const needsJobPin = lease.actualJobId !== servedJobId;
	const needsRunPin =
		assignment.runId > 0 && lease.originalRunId !== assignment.runId;
	if (!needsJobPin && !needsRunPin) return { lease, assignment, holdsActive };
	let updated: Lease | undefined;
	try {
		updated = await store.transition(
			lease.id,
			[...ACTIVE_STATES],
			(entry) => {
				entry.actualJobId = servedJobId;
				if (assignment.runId > 0) entry.originalRunId = assignment.runId;
			},
			"ci.JobObserved",
			at,
		);
	} catch {
		return { lease, assignment, holdsActive };
	}
	if (updated) {
		log?.("hobo_ci_jit_runner_custody_transferred", {
			leaseId: lease.id,
			reservedJobId,
			servedJobId: assignment.jobId,
			servedRunId: assignment.runId,
			servedStatus: assignment.status,
			runnerName: lease.runnerName,
		});
		if (servedJobId !== reservedJobId) {
			const reserved = reservedJobWithdraw(lease);
			await store.withdrawQueuedJob?.(
				create(JobSchema, {
					...reserved,
					id: reservedJobId,
					runId: reservedRunId,
				}),
				at,
				undefined,
				lease.id,
			);
		}
		return { lease: updated, assignment, holdsActive };
	}
	const current = await store.get(lease.id);
	return { lease: current ?? lease, assignment, holdsActive };
}
