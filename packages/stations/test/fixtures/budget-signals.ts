import {
	foldBudgetSignals,
	latestBudgetTransition,
} from "../../../broker/src/budget-signals.js";

export function budgetSignals(tenantId: string) {
	const policy = { tenantId, budgetUsd: 100, thresholds: [0.8] };
	function history(cycle: number) {
		const facts: Array<{
			type: string;
			data: { tenantId: string; costUsd?: number; amountUsd?: number };
		}> = [{ type: "meter.UsageRecorded", data: { tenantId, costUsd: 80 } }];
		for (let index = 2; index <= cycle; index++) {
			facts.push(
				index % 2 === 0
					? { type: "budget.CreditApplied", data: { tenantId, amountUsd: 1 } }
					: { type: "meter.UsageRecorded", data: { tenantId, costUsd: 1 } },
			);
		}
		return facts;
	}
	let facts = history(1);
	return {
		evidence: () => latestBudgetTransition(facts, policy, 0.8),
		signal: (cycle = 1) => {
			facts = history(cycle);
			const fact = foldBudgetSignals(facts, policy).signals.at(-1);
			if (!fact) throw new Error("expected a budget threshold transition");
			return { kind: "budget" as const, fact };
		},
	};
}
