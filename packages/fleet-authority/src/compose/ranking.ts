/**
 * The authority's own ranking for `report` (D59). `createEnrollmentAuthority`
 * re-checks a violation report's claims with `parts.checkClaim` and an empty
 * `ranked`, which lets a claimant that signed rank 0 into its claim escape an
 * early report. Composed here, the claim rules receive the ranking of the
 * fleet's executors from the view the registry projection (L31) publishes:
 * every ACTIVE device holding the EXECUTOR role, weighted as the dispatcher
 * weights them (free slots times measured reliability), ordered by L03's
 * `rankMembers`. A caller that passes its own ranking keeps it.
 */
import {
	type FleetView,
	type MemberId,
	MemberKind,
	MemberState,
	parseFleetId,
	parseMemberId,
	type RegistryView,
	Role,
} from "@hobo/fleet";
import { rankMembers } from "@hobo/fleet/observation";
import type { checkClaim } from "@hobo/fleet/work";

type CheckClaim = typeof checkClaim;

export function rankedFromView(
	view: FleetView | undefined,
	digest: Parameters<typeof rankMembers>[0],
): readonly MemberId[] {
	if (view === undefined) return [];
	const candidates = view.members
		.filter(
			(member) =>
				member.kind === MemberKind.DEVICE &&
				member.state === MemberState.ACTIVE &&
				member.roles.includes(Role.EXECUTOR),
		)
		.map((member) => ({
			memberId: parseMemberId(member.memberId),
			copies: Math.max(1, member.capacity?.freeSlots ?? 1),
			reliability: member.reliability ?? 1,
		}));
	return rankMembers(digest, candidates);
}

/** `checkClaim` with the projection's ranking substituted for an empty one. */
export function withProjectionRanking(
	check: CheckClaim,
	registry: () => RegistryView,
): CheckClaim {
	return async (claim, subject, offer, context) => {
		if (context.ranked.length > 0) return check(claim, subject, offer, context);
		let ranked: readonly MemberId[] = [];
		try {
			const view = await registry().view(parseFleetId(subject.fleet));
			ranked = rankedFromView(view, subject.digest);
		} catch {
			ranked = [];
		}
		return check(claim, subject, offer, { ...context, ranked });
	};
}
