import {
	type Account,
	type CiRoutingOptions,
	ciQueueBudgetMs,
	type Lease,
} from "@hobo/ci";

/** Repricing is feasibility only. The durable store must still claim the exact
 * financial reservation, including strict native proof, before any provider effect. */
export function heldRoutingOptions(
	account: Account,
	lease: Lease,
	at: string,
): CiRoutingOptions {
	const queueBound = ciQueueBudgetMs(account);
	return {
		phase: "plan",
		attempt: lease.runAttempt + (lease.budgetAdmissionAttempt || 1) - 1,
		// A pinned earlier deadline is conservatively older than the policy horizon.
		queueDurationMs: Math.max(
			0,
			queueBound !== undefined && lease.queueDeadlineAt
				? queueBound + Date.parse(at) - Date.parse(lease.queueDeadlineAt)
				: Date.parse(at) - Date.parse(lease.createdAt),
		),
	};
}
