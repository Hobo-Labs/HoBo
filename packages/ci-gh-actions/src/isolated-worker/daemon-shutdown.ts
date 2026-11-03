import type { Configuration } from "@hobo/ci";
import { isIsolatedContainerOffer } from "../isolated-backend.js";

/** Lease states where this worker may still be launching or running a container. */
export const IN_FLIGHT_WORKER_LEASE_STATES = new Set([
	"dispatching",
	"claiming",
	"dispatched",
	"running",
]);

type WorkerLeaseRow = Readonly<{
	accountId: string;
	offerId: string;
	state: string;
}>;

/** Offer ids are unique per account only, so ownership keys on both. */
export function workerOfferKey(accountId: string, offerId: string): string {
	return `${accountId}\0${offerId}`;
}

/**
 * The offers this worker launches containers for: isolated-container offers
 * whose `providerAccountId` is the worker, disabled ones included (a lease
 * outlives its offer being switched off). A lease's `accountId` is the
 * customer account that owns the job, never the worker.
 */
export function workerOfferKeys(
	configuration: Configuration | undefined,
	workerAccountId: string,
): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const account of configuration?.accounts ?? [])
		for (const offer of account.offers)
			if (
				isIsolatedContainerOffer(offer) &&
				offer.providerAccountId === workerAccountId
			)
				keys.add(workerOfferKey(account.id, offer.id));
	return keys;
}

export function countInFlightWorkerLeases(
	leases: readonly WorkerLeaseRow[],
	workerOffers: ReadonlySet<string>,
): number {
	return leases.filter(
		(lease) =>
			workerOffers.has(workerOfferKey(lease.accountId, lease.offerId)) &&
			IN_FLIGHT_WORKER_LEASE_STATES.has(lease.state),
	).length;
}

/**
 * Waits until nothing this worker launched is still in flight, running jobs
 * included. A lease leaves `running` only when a reconcile sees its runner
 * exit, so `reconcile` (a tick that admits nothing) runs before every count.
 */
export async function waitForIsolatedWorkerDrain(options: {
	inFlight: () => Promise<number>;
	reconcile: () => Promise<void>;
	pollMs: number;
	timeoutMs: number;
	onWaiting?: (remaining: number) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<{ drained: boolean; remaining: number }> {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const deadline = now() + options.timeoutMs;
	const count = async () => {
		await options.reconcile().catch(() => undefined);
		return options.inFlight();
	};
	while (now() < deadline) {
		const remaining = await count();
		if (remaining === 0) return { drained: true, remaining: 0 };
		options.onWaiting?.(remaining);
		const waitMs = Math.min(options.pollMs, Math.max(0, deadline - now()));
		if (waitMs > 0) await sleep(waitMs);
	}
	const remaining = await count();
	return { drained: remaining === 0, remaining };
}
