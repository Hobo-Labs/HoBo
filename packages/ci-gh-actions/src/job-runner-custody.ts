import { ACTIVE_STATES, type Lease } from "@hobo/ci";

/** JIT runners the box worker registers: `hobo-<lease-uuid>`. */
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

/** Box JIT runner or an in-flight isolated launch still holding the reservation. */
export function hasOutstandingBoxCustody(
	lease: Lease,
	repositoryId: number,
	jobId: number,
	runAttempt: number | undefined,
): boolean {
	if (!ACTIVE_STATES.has(lease.state)) return false;
	if (!activeLeaseCoversJob(lease, repositoryId, jobId, runAttempt))
		return false;
	if (lease.runnerId > 0) return true;
	if (lease.runnerName !== "") return true;
	return (
		lease.state !== "reserved" ||
		lease.sandboxName !== "" ||
		lease.dispatchingAt !== ""
	);
}
