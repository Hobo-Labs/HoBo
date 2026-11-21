import {
	type FleetFinancialModel,
	parseFleetFinancialModel,
} from "@hobo/backend-fleet";

// The vendor plans a CD journal fleet member may run on, as the fleet's cost
// model for that member (`reconcileFleet({ models })`): what it costs a month
// and what it includes, so a move never lands the journal on a member it would
// push over its allowance or the policy's budget.
//
// A member names its plan in its fleet entry (`HOBO_CD_POSTGRES_FLEET=
// neon-eu:neon-claimable`). Only numbers with a source are filled in; what
// nobody has verified stays unknown, which the fleet treats as a hard stop
// rather than an assumption. A member with no plan is cost-blind.

const MB = 1024 * 1024;

/** One plan: its model without the member id, which the fleet entry supplies. */
type MemberPlan = Omit<FleetFinancialModel, "backend">;

export const CD_JOURNAL_MEMBER_PLANS: Readonly<Record<string, MemberPlan>> =
	Object.freeze({
		// Neon Claimable Postgres, unclaimed: free, 100 MB of storage, then the
		// database refuses writes; once claimed it is on the claimer's Neon plan.
		"neon-claimable": {
			plan: "neon-claimable",
			fixedMonthlyFeeMicros: 0,
			allowances: [
				{
					unit: "storage-bytes",
					included: 100 * MB,
					beyond: "hard-stop",
					meteredMicrosPerUnit: undefined,
				},
			],
			evidence: {
				source: "https://neon.com/docs/reference/claimable-postgres",
				observedAt: "2026-08-08",
			},
		},
		// Prisma Postgres via create-db, unclaimed: free; its allowances are not
		// documented on the pages this repository verified.
		"prisma-postgres-claimable": {
			plan: "prisma-postgres-claimable",
			fixedMonthlyFeeMicros: 0,
			allowances: [
				{
					unit: "storage-bytes",
					included: undefined,
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
			],
			evidence: {
				source: "https://github.com/prisma/create-db",
				observedAt: "2026-08-08",
			},
		},
	});

export class UnknownMemberPlanError extends Error {
	constructor(
		readonly member: string,
		readonly plan: string,
	) {
		super(
			`fleet member ${member} names plan ${plan}, which is not one of ${Object.keys(CD_JOURNAL_MEMBER_PLANS).join(", ")}`,
		);
		this.name = "UnknownMemberPlanError";
	}
}

/** The cost models of the members that name a plan; a member without one is cost-blind. */
export function journalMemberModels(
	members: readonly Readonly<{ id: string; plan?: string }>[],
): readonly FleetFinancialModel[] {
	return members.flatMap((member) => {
		if (member.plan === undefined) return [];
		const plan = CD_JOURNAL_MEMBER_PLANS[member.plan];
		if (plan === undefined)
			throw new UnknownMemberPlanError(member.id, member.plan);
		return [parseFleetFinancialModel({ ...plan, backend: member.id })];
	});
}
