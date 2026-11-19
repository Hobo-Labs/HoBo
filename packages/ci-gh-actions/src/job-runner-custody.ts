import { ACTIVE_STATES, type Lease } from "@hobo/ci";

const BOX_LEASE_RUNNER =
	/^hobo-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RunnerCustody = "unassigned" | "box" | "foreign";

export function runnerCustody(
	runnerName: string | null | undefined,
): RunnerCustody {
	const name = runnerName?.trim();
	if (!name) return "unassigned";
	return BOX_LEASE_RUNNER.test(name) ? "box" : "foreign";
}

export function leaseIdFromBoxRunnerName(
	runnerName: string,
): string | undefined {
	const match = BOX_LEASE_RUNNER.exec(runnerName.trim());
	if (!match) return undefined;
	return runnerName.trim().slice("hobo-".length);
}

export function activeLeaseCoversJob(
	lease: Lease,
	repositoryId: number,
	jobId: number,
	runAttempt: number | undefined,
): boolean {
	const matchesAttempt =
		runAttempt === undefined || lease.runAttempt === runAttempt;
	return (
		lease.repositoryId === repositoryId &&
		matchesAttempt &&
		((lease.jobId === jobId &&
			(lease.actualJobId === 0 || lease.actualJobId === jobId)) ||
			lease.actualJobId === jobId)
	);
}

export function hasOutstandingBoxCustody(
	lease: Lease,
	repositoryId: number,
	jobId: number,
	runAttempt: number | undefined,
): boolean {
	return (
		ACTIVE_STATES.has(lease.state) &&
		activeLeaseCoversJob(lease, repositoryId, jobId, runAttempt)
	);
}
