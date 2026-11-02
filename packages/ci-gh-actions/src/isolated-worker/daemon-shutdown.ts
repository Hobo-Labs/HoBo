/** Lease states where this worker may still be launching or running a container. */
export const IN_FLIGHT_WORKER_LEASE_STATES = new Set([
	"dispatching",
	"claiming",
	"dispatched",
	"running",
]);

export function isWorkerManagedLease(
	lease: { accountId: string; provider: string },
	workerAccountId: string,
): boolean {
	return (
		lease.accountId === workerAccountId &&
		(lease.provider === "kubernetes" || lease.provider === "hobo-box-worker")
	);
}

export function countInFlightWorkerLeases(
	leases: readonly { accountId: string; provider: string; state: string }[],
	workerAccountId: string,
): number {
	return leases.filter(
		(lease) =>
			isWorkerManagedLease(lease, workerAccountId) &&
			IN_FLIGHT_WORKER_LEASE_STATES.has(lease.state),
	).length;
}

export async function waitForIsolatedWorkerDrain(options: {
	activeLeases: () => Promise<
		readonly { accountId: string; provider: string; state: string }[]
	>;
	workerAccountId: string;
	pollMs: number;
	timeoutMs: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<{ drained: boolean; remaining: number }> {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const deadline = now() + options.timeoutMs;
	while (now() < deadline) {
		const leases = await options.activeLeases();
		const remaining = countInFlightWorkerLeases(leases, options.workerAccountId);
		if (remaining === 0) return { drained: true, remaining: 0 };
		const waitMs = Math.min(options.pollMs, Math.max(0, deadline - now()));
		if (waitMs > 0) await sleep(waitMs);
	}
	const leases = await options.activeLeases();
	const remaining = countInFlightWorkerLeases(leases, options.workerAccountId);
	return { drained: remaining === 0, remaining };
}
