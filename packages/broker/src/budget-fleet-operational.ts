import { createHash, randomUUID } from "node:crypto";
import type { ImmutableJournal } from "@hobo/backend-fleet";
import { ImmutableJournalError } from "@hobo/backend-fleet";
import type { AsyncActorLeaseHost } from "@hobo/core";
import type {
	BudgetIdentity,
	BudgetLedgerSnapshot,
} from "./budget-authority.js";
import type { BudgetFenceTrust } from "./budget-fence-settlement.js";
import { createFleetBudgetAdmissionAuthority } from "./budget-fleet.js";

/** Operational view: recovery is a separately funded mutation guarded by a
 * durable actor lease. Read-only preflight uses the base authority instead.
 * Each replica must independently meter/fence its own I/O, including requests
 * that finish after a caller or its actor lease has timed out. */
export function createOperationalFleetBudgetAdmissionAuthority(input: {
	readonly journal: ImmutableJournal;
	readonly snapshot: BudgetLedgerSnapshot;
	/** The independently enrolled current partition; it can differ from the
	 * journal's original snapshot after an authorized policy/period change. */
	readonly recoveryIdentity: BudgetIdentity;
	readonly now?: () => string;
	readonly fenceTrust?: BudgetFenceTrust;
	readonly actorHost: AsyncActorLeaseHost;
	readonly authorizeRecovery: (
		scope: Readonly<{
			tenantId: string;
			budgetId: string;
			periodId: string;
			policyRevision: string;
			fleetId: string;
			anchorDigest: string;
			actor: Readonly<{
				key: string;
				holderId: string;
				fenceToken: bigint;
				expiresAt: string;
			}>;
		}>,
	) => Promise<() => Promise<void>>;
}) {
	const identity = input.recoveryIdentity;
	if (
		!identity?.tenantId ||
		!identity.budgetId ||
		!identity.periodId ||
		!identity.policyRevision ||
		identity.tenantId !== input.snapshot.identity?.tenantId ||
		identity.budgetId !== input.snapshot.identity?.budgetId ||
		!input.actorHost ||
		!(input.authorizeRecovery instanceof Function)
	)
		throw new Error(
			"operational Broker recovery requires an exact budget and funded actor authority",
		);
	const scope = Object.freeze({
		tenantId: identity.tenantId,
		budgetId: identity.budgetId,
		periodId: identity.periodId,
		policyRevision: identity.policyRevision,
		fleetId: input.journal.fleetId,
		anchorDigest: input.journal.anchorDigest,
	});
	// All policy revisions and periods of this journal share one actor fence.
	const key = `broker-recovery:${createHash("sha256")
		.update(
			JSON.stringify([
				scope.tenantId,
				scope.budgetId,
				scope.fleetId,
				scope.anchorDigest,
			]),
		)
		.digest("hex")}`;
	const acquire = input.actorHost.acquire.bind(input.actorHost),
		journal = input.journal,
		authorize = input.authorizeRecovery;
	async function performRecovery(): Promise<void> {
		const holderId = `broker-recovery:${randomUUID()}`;
		const lease = await acquire(key, { holderId });
		try {
			if (
				lease.key !== key ||
				lease.holderId !== holderId ||
				lease.fenceToken < 1n ||
				!(lease.revalidate instanceof Function) ||
				!(lease.release instanceof Function) ||
				!Number.isFinite(Date.parse(lease.expiresAt))
			)
				throw new Error("Broker recovery actor lease is invalid");
			await lease.revalidate();
			const guard = await authorize(
				Object.freeze({
					...scope,
					actor: Object.freeze({
						key,
						holderId,
						fenceToken: lease.fenceToken,
						expiresAt: lease.expiresAt,
					}),
				}),
			);
			if (!(guard instanceof Function))
				throw new Error("Broker recovery funding is unavailable");
			await guard();
			await lease.revalidate();
			await journal.recover();
			await lease.revalidate();
			await guard();
		} finally {
			await lease.release();
		}
	}
	let inFlight: Promise<void> | undefined;
	function recover(): Promise<void> {
		if (inFlight) return inFlight;
		const pending = performRecovery();
		inFlight = pending;
		void pending.then(
			() => {
				if (inFlight === pending) inFlight = undefined;
			},
			() => {
				if (inFlight === pending) inFlight = undefined;
			},
		);
		return pending;
	}
	const base = createFleetBudgetAdmissionAuthority({
		journal,
		snapshot: input.snapshot,
		...(input.fenceTrust ? { fenceTrust: input.fenceTrust } : undefined),
		...(input.now ? { now: input.now } : undefined),
		recover,
	});
	async function inspect<T>(read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			if (
				!(error instanceof ImmutableJournalError) ||
				error.reason !== "quorum-unavailable"
			)
				throw error;
			await recover();
			return read();
		}
	}
	return Object.freeze({
		...base,
		read: (...args: Parameters<typeof base.read>) =>
			inspect(() => base.read(...args)),
		lookup: (...args: Parameters<typeof base.lookup>) =>
			inspect(() => base.lookup(...args)),
	});
}
