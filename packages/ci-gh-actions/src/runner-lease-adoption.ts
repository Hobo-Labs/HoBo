import { ACTIVE_STATES, type Lease } from "@hobo/ci";
import type { GithubTransport } from "./github.js";
import type { HostedRelayStore } from "./hosted-relay.js";
import {
	type ResolvedRunnerAssignment,
	resolveRunnerAssignedJob,
	runnerHoldsActiveJob,
} from "./jit-runner-correlation.js";

export type RunnerCustodyAdoption = Readonly<{
	lease: Lease;
	assignment?: ResolvedRunnerAssignment;
	holdsActive: boolean;
}>;

/** Pin `actualJobId` / `originalRunId` to the job GitHub assigned this runner. */
export async function adoptRunnerAssignment(
	store: Pick<HostedRelayStore, "get" | "transition">,
	github: GithubTransport,
	lease: Lease,
	at: string,
	log?: (
		event: "hobo_ci_jit_runner_custody_transferred",
		fields: Readonly<Record<string, string | number>>,
	) => void,
): Promise<RunnerCustodyAdoption> {
	if (!lease.runnerName) return { lease, holdsActive: false };
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
	if (lease.actualJobId > 0 && lease.actualJobId !== servedJobId)
		return { lease, assignment, holdsActive };
	if (lease.actualJobId === servedJobId)
		return { lease, assignment, holdsActive };
	let updated: Lease | undefined;
	try {
		updated = await store.transition(
			lease.id,
			[...ACTIVE_STATES],
			(entry) => {
				if (entry.actualJobId > 0 && entry.actualJobId !== servedJobId)
					throw new Error("runner job assignment conflict");
				entry.actualJobId = servedJobId;
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
			reservedJobId: lease.jobId,
			servedJobId: assignment.jobId,
			servedRunId: assignment.runId,
			servedStatus: assignment.status,
			runnerName: lease.runnerName,
		});
		return { lease: updated, assignment, holdsActive };
	}
	const current = await store.get(lease.id);
	return { lease: current ?? lease, assignment, holdsActive };
}
