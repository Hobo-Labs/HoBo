import {
	type Account,
	type CiRoutingOptions,
	ciQueueBudgetMs,
	type Lease,
} from "@hobo/ci";

export function heldRoutingOptions(
	account: Account,
	lease: Lease,
	at: string,
): CiRoutingOptions {
	const queueBound = ciQueueBudgetMs(account);
	return {
		phase: "plan",
		attempt: lease.runAttempt + (lease.budgetAdmissionAttempt || 1) - 1,
		queueDurationMs: Math.max(
			0,
			queueBound !== undefined && lease.queueDeadlineAt
				? queueBound + Date.parse(at) - Date.parse(lease.queueDeadlineAt)
				: Date.parse(at) - Date.parse(lease.createdAt),
		),
	};
}
