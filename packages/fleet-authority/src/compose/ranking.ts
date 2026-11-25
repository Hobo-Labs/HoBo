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
