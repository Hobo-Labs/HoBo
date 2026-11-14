import type { Job, Lease } from "@hobo/ci";
import {
	type PeerCapacityWitness,
	peersCanAbsorbUnlaunchedRelease,
} from "./peer-capacity.js";
import {
	type TrunkWaitCache,
	type TrunkWaitState,
	trunkWaitFleetDeferEligible,
	trunkWaitKey,
} from "./trunk-wait.js";

export {
	type PeerCapacityWitness,
	peersCanAbsorbUnlaunchedRelease,
} from "./peer-capacity.js";

export const DEFAULT_UNLAUNCHED_RESERVE_MS = 25_000;
export const DEFAULT_UNLAUNCHED_BACKLOG_MIN_AGE_MS = 25_000;
export const DEFAULT_UNLAUNCHED_RE_RESERVE_COOLDOWN_MS = 30_000;

export type UnlaunchedReservationLease = Readonly<
	Pick<
		Lease,
		| "id"
		| "state"
		| "sandboxName"
		| "sandboxSessionId"
		| "runnerId"
		| "createdAt"
		| "jobId"
		| "installationId"
		| "repository"
		| "runAttempt"
	>
>;

export function unlaunchedJobCoopKey(
	ref: Pick<
		UnlaunchedReservationLease,
		"installationId" | "repository" | "runAttempt"
	> &
		Readonly<{ jobId: number }>,
): string {
	return `${ref.installationId}:${ref.repository}:${ref.jobId}:${ref.runAttempt}`;
}

export function unlaunchedJobCoopKeyFromPending(
	job: Pick<Job, "installationId" | "repository" | "id" | "runAttempt">,
): string {
	return `${job.installationId}:${job.repository}:${job.id}:${job.runAttempt}`;
}

export function isUnlaunchedReservation(
	lease: UnlaunchedReservationLease,
): boolean {
	return (
		lease.state === "reserved" &&
		!lease.sandboxName &&
		!lease.sandboxSessionId &&
		lease.runnerId === 0
	);
}

export function unlaunchedReservationAgeMs(
	lease: UnlaunchedReservationLease,
	nowMs: number,
): number {
	const created = Date.parse(lease.createdAt);
	return Number.isFinite(created) ? Math.max(0, nowMs - created) : 0;
}

function fleetWitnessFromReleaseContext(
	context: Pick<UnlaunchedReleaseContext, "fleetWitness" | "nonLocalFreeSlots">,
): PeerCapacityWitness | undefined {
	if (context.fleetWitness) return context.fleetWitness;
	if (context.nonLocalFreeSlots === undefined) return undefined;
	return { fleetFreeSlots: context.nonLocalFreeSlots };
}

export type UnlaunchedReleaseContext = Readonly<{
	boundMs: number;
	backlogMinAgeMs: number;
	pendingDemand: number;
	unlaunchedCount: number;
	launchSlots: number;
	liveContainerCount: number;
	/** Fleet witness: immediate backlog release is enabled. */
	backlogImmediate: boolean;
	/** Fleet witness; release fail-closed when no peer absorb capacity. */
	fleetWitness?: PeerCapacityWitness;
	/** @deprecated use fleetWitness */
	nonLocalFreeSlots?: number;
}>;

export function unlaunchedReleaseReason(
	lease: UnlaunchedReservationLease,
	nowMs: number,
	context: UnlaunchedReleaseContext,
): string | undefined {
	if (!isUnlaunchedReservation(lease)) return undefined;
	if (!peersCanAbsorbUnlaunchedRelease(fleetWitnessFromReleaseContext(context)))
		return undefined;
	const ageMs = unlaunchedReservationAgeMs(lease, nowMs);
	if (ageMs >= context.boundMs) return "launch-bound-exceeded";
	if (!context.backlogImmediate) return undefined;
	if (ageMs < context.backlogMinAgeMs) return undefined;
	const outstanding = context.unlaunchedCount + context.pendingDemand;
	const capacity = Math.max(
		0,
		context.launchSlots - context.liveContainerCount,
	);
	if (outstanding > capacity) return "admission-backlog";
	return undefined;
}

/** Oldest unlaunched reservations first so newer demand can still launch locally. */
export function pickUnlaunchedReservationsToRelease(
	leases: readonly UnlaunchedReservationLease[],
	nowMs: number,
	context: UnlaunchedReleaseContext,
): ReadonlyArray<Readonly<{ leaseId: string; jobId: number; reason: string }>> {
	const canFleetAbsorb = peersCanAbsorbUnlaunchedRelease(
		fleetWitnessFromReleaseContext(context),
	);
	if (!canFleetAbsorb) return [];
	const unlaunched = leases
		.filter(isUnlaunchedReservation)
		.sort(
			(a, b) =>
				unlaunchedReservationAgeMs(b, nowMs) -
					unlaunchedReservationAgeMs(a, nowMs) ||
				a.createdAt.localeCompare(b.createdAt) ||
				a.id.localeCompare(b.id),
		);
	const releases: { leaseId: string; jobId: number; reason: string }[] = [];
	let unlaunchedLeft = unlaunched.length;
	const capacity = Math.max(
		0,
		context.launchSlots - context.liveContainerCount,
	);
	for (const lease of unlaunched) {
		const ageMs = unlaunchedReservationAgeMs(lease, nowMs);
		let reason: string | undefined;
		if (ageMs >= context.boundMs) reason = "launch-bound-exceeded";
		else if (
			context.backlogImmediate &&
			ageMs >= context.backlogMinAgeMs &&
			context.pendingDemand + unlaunchedLeft > capacity
		)
			reason = "admission-backlog";
		if (!reason) continue;
		releases.push({ leaseId: lease.id, jobId: lease.jobId, reason });
		unlaunchedLeft -= 1;
	}
	return releases;
}

export function pickTrunkHeadroomFleetReleases(
	trunkWaits: TrunkWaitCache,
	leases: readonly UnlaunchedReservationLease[],
	nowMs: number,
	context: Readonly<{
		deferMs: number;
		fleetWitness?: PeerCapacityWitness;
		nonLocalFreeSlots?: number;
	}>,
): ReadonlyArray<
	Readonly<{
		leaseId: string;
		jobId: number;
		reason: string;
		waitKey: string;
		waitedMs: number;
	}>
> {
	if (!peersCanAbsorbUnlaunchedRelease(fleetWitnessFromReleaseContext(context)))
		return [];
	const releases: {
		leaseId: string;
		jobId: number;
		reason: string;
		waitKey: string;
		waitedMs: number;
	}[] = [];
	for (const [waitKey, wait] of trunkWaits) {
		if (!trunkWaitFleetDeferEligible(wait, context.deferMs, nowMs)) continue;
		const parts = waitKey.split(":");
		if (parts.length !== 3) continue;
		const repository = parts[0];
		const jobId = Number(parts[1]);
		const runAttempt = Number(parts[2]);
		if (
			!repository ||
			!Number.isInteger(jobId) ||
			jobId <= 0 ||
			!Number.isInteger(runAttempt) ||
			runAttempt <= 0
		)
			continue;
		const lease = leases.find(
			(entry) =>
				entry.repository === repository &&
				entry.jobId === jobId &&
				entry.runAttempt === runAttempt &&
				isUnlaunchedReservation(entry),
		);
		if (!lease) continue;
		const waitedMs = Math.max(0, nowMs - wait.sinceMs);
		releases.push({
			leaseId: lease.id,
			jobId: lease.jobId,
			reason: `trunk-${wait.reason}-fleet-defer`,
			waitKey,
			waitedMs,
		});
	}
	return releases;
}

export function rememberTrunkWait(
	cache: TrunkWaitCache,
	job: Pick<Job, "repository" | "id" | "runAttempt">,
	reason: TrunkWaitState["reason"],
	nowMs: number,
): TrunkWaitState {
	const key = trunkWaitKey(job);
	const existing = cache.get(key);
	const wait: TrunkWaitState =
		existing?.reason === reason
			? existing
			: { sinceMs: nowMs, logged: false, reason };
	cache.set(key, wait);
	return wait;
}
