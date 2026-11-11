import type { Lease } from "@hobo/ci";

export const DEFAULT_UNLAUNCHED_RESERVE_MS = 25_000;

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
	>
>;

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

export type UnlaunchedReleaseContext = Readonly<{
	boundMs: number;
	pendingDemand: number;
	unlaunchedCount: number;
	launchSlots: number;
	liveContainerCount: number;
	backlogImmediate: boolean;
}>;

export function unlaunchedReleaseReason(
	lease: UnlaunchedReservationLease,
	nowMs: number,
	context: UnlaunchedReleaseContext,
): string | undefined {
	if (!isUnlaunchedReservation(lease)) return undefined;
	const ageMs = unlaunchedReservationAgeMs(lease, nowMs);
	if (ageMs >= context.boundMs) return "launch-bound-exceeded";
	if (!context.backlogImmediate || ageMs === 0) return undefined;
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
			ageMs > 0 &&
			context.pendingDemand + unlaunchedLeft > capacity
		)
			reason = "admission-backlog";
		if (!reason) continue;
		releases.push({ leaseId: lease.id, jobId: lease.jobId, reason });
		unlaunchedLeft -= 1;
	}
	return releases;
}
