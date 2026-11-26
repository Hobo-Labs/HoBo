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

/** Running worker containers without a counted lease still block drain. */
export function mergeDrainInFlightCount(
	leaseCount: number,
	runningWorkerContainers: number,
): number {
	return Math.max(leaseCount, runningWorkerContainers);
}

export type WorkerBackgroundDrainKind =
	| "tick"
	| "inbox"
	| "jobPoll"
	| "gc"
	| "orphanReconcile";

/** SIGTERM must not wait on poll/tick/inbox longer than this when no job runs. */
export const DEFAULT_DRAIN_BACKGROUND_BOUND_MS = 30_000;

export async function awaitWorkerBackgroundDrainIdle(options: {
	inFlight: () => readonly WorkerBackgroundDrainKind[];
	boundMs?: number;
	pollMs?: number;
	onProgress?: (
		fields: Readonly<{
			elapsedMs: number;
			boundMs: number;
			inFlight: readonly WorkerBackgroundDrainKind[];
		}>,
	) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<
	Readonly<{
		timedOut: boolean;
		inFlight: readonly WorkerBackgroundDrainKind[];
	}>
> {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? Date.now;
	const boundMs = options.boundMs ?? DEFAULT_DRAIN_BACKGROUND_BOUND_MS;
	const pollMs = Math.min(options.pollMs ?? 2_000, boundMs);
	const startedAt = now();
	let lastLoggedMs = Number.NEGATIVE_INFINITY;
	while (now() - startedAt < boundMs) {
		const active = options.inFlight();
		if (active.length === 0) return { timedOut: false, inFlight: [] as const };
		const elapsedMs = now() - startedAt;
		if (elapsedMs - lastLoggedMs >= pollMs) {
			lastLoggedMs = elapsedMs;
			options.onProgress?.({ elapsedMs, boundMs, inFlight: active });
		}
		await sleep(Math.min(pollMs, boundMs - elapsedMs));
	}
	const inFlight = options.inFlight();
	return { timedOut: inFlight.length > 0, inFlight };
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
	onProgress?: (
		fields: Readonly<{
			remaining: number;
			elapsedMs: number;
			timeoutMs: number;
		}>,
	) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<{ drained: boolean; remaining: number }> {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const startedAt = now();
	const deadline = startedAt + options.timeoutMs;
	const count = async () => {
		await options.reconcile().catch(() => undefined);
		return options.inFlight();
	};
	while (now() < deadline) {
		const remaining = await count();
		if (remaining === 0) return { drained: true, remaining: 0 };
		options.onWaiting?.(remaining);
		options.onProgress?.({
			remaining,
			elapsedMs: now() - startedAt,
			timeoutMs: options.timeoutMs,
		});
		const waitMs = Math.min(options.pollMs, Math.max(0, deadline - now()));
		if (waitMs > 0) await sleep(waitMs);
	}
	const remaining = await count();
	return { drained: remaining === 0, remaining };
}

export type WorkerStopMode = "handoff" | "drain";

export function parseWorkerStopMode(value: string | undefined): WorkerStopMode {
	if (value === undefined || value === "" || value === "handoff")
		return "handoff";
	if (value === "drain") return "drain";
	throw new Error("invalid HOBO_CI_WORKER_STOP_MODE");
}

/** Second drain signal may exit when inventory shows no running worker containers. */
export async function shouldForceExitDrainOnRepeatSignal(options: {
	signalCount: number;
	draining: boolean;
	runningWorkerContainers: number;
}): Promise<boolean> {
	if (options.signalCount < 2 || !options.draining) return false;
	return options.runningWorkerContainers === 0;
}

export async function stopIsolatedWorker(options: {
	mode: WorkerStopMode;
	inFlight: () => Promise<number>;
	reconcile: () => Promise<void>;
	pollMs: number;
	timeoutMs: number;
	onWaiting?: (remaining: number) => void;
	onProgress?: (
		fields: Readonly<{
			remaining: number;
			elapsedMs: number;
			timeoutMs: number;
		}>,
	) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<{
	mode: WorkerStopMode;
	drained: boolean;
	remaining: number;
}> {
	if (options.mode === "handoff") {
		await options.reconcile().catch(() => undefined);
		return {
			mode: "handoff",
			drained: false,
			remaining: await options.inFlight(),
		};
	}
	const result = await waitForIsolatedWorkerDrain(options);
	return { mode: "drain", ...result };
}
