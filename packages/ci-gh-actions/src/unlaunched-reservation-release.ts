import type { Job, Lease } from "@hobo/ci";

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

/** Non-local mesh capacity (peer box slots and ARC) must absorb released custody. */
export function fleetCanAbsorbUnlaunchedRelease(
	nonLocalFreeSlots: number | undefined,
): boolean {
	return nonLocalFreeSlots !== undefined && nonLocalFreeSlots > 0;
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
	/** Peer/ARC slots reported on mesh; release fail-closed when absent. */
	nonLocalFreeSlots?: number;
}>;

export function unlaunchedReleaseReason(
	lease: UnlaunchedReservationLease,
	nowMs: number,
	context: UnlaunchedReleaseContext,
): string | undefined {
	if (!isUnlaunchedReservation(lease)) return undefined;
	if (!fleetCanAbsorbUnlaunchedRelease(context.nonLocalFreeSlots))
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
	const canFleetAbsorb = fleetCanAbsorbUnlaunchedRelease(
		context.nonLocalFreeSlots,
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
