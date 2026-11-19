import {
	type FleetFinancialModel,
	parseFleetFinancialModel,
} from "@hobo/backend-fleet";

const MB = 1024 * 1024;

type MemberPlan = Omit<FleetFinancialModel, "backend">;

export const CD_JOURNAL_MEMBER_PLANS: Readonly<Record<string, MemberPlan>> =
	Object.freeze({
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
