import type { ConfigurationState, Lease } from "@hobo/ci";
import type { HostedRelay, HostedRelayStore } from "./hosted-relay.js";

/**
 * What an account may read and do to its own leases and inbox. The account
 * API (`hosted-control.ts`) and the MCP server (`relay-mcp.ts`) both call
 * these, so the ownership checks and their refusals are written once.
 */

/** A refusal with the HTTP status the account API answers it with. */
export class ControlError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** A webhook delivery set aside after it failed too many times. */
export type QuarantinedDelivery = Readonly<{
	deliveryId: string;
	event: string;
	installationId: number;
	repositoryId: number;
	receivedAt: string;
	attempts: number;
}>;

/** The store reads and writes these operations need. */
export type AccountOperationsStore = Pick<
	HostedRelayStore,
	"configuration" | "get"
> & {
	quarantinedWebhooks(
		accountId: string,
		expectedRevision: number,
	): Promise<QuarantinedDelivery[]>;
	retryQuarantinedWebhook(
		accountId: string,
		expectedRevision: number,
		deliveryId: string,
	): Promise<boolean>;
};

/** The stored configuration, or the refusal a relay without one answers. */
export async function configurationState(
	store: Pick<HostedRelayStore, "configuration">,
): Promise<ConfigurationState> {
	const result = await store.configuration();
	if (!result?.configuration)
		throw new ControlError(503, "configuration unavailable");
	return result;
}

/** A lease this account owns. Another account's lease is as absent as a missing one. */
export async function accountLease(
	store: Pick<HostedRelayStore, "get">,
	accountId: string,
	leaseId: string,
): Promise<Lease> {
	const found = await store.get(leaseId);
	if (!found || found.accountId !== accountId)
		throw new ControlError(404, "lease not found");
	return found;
}

/**
 * Reconcile an account's lease against a host run the caller has verified.
 * The relay still checks the host's identity, source, label and completion.
 */
export async function reconcileAccountLease(
	relay: Pick<HostedRelay, "reconcile">,
	store: Pick<HostedRelayStore, "get">,
	accountId: string,
	leaseId: string,
	hostRunId: number,
): Promise<Lease> {
	const found = await accountLease(store, accountId, leaseId);
	if (!Number.isSafeInteger(hostRunId) || hostRunId < 1)
		throw new ControlError(400, "positive host run id required");
	await relay.reconcile(found.id, hostRunId);
	return (await store.get(found.id)) ?? found;
}

/** The account's quarantined deliveries, with the revision a retry must name. */
export async function quarantinedDeliveries(
	store: AccountOperationsStore,
	accountId: string,
): Promise<{ revision: number; deliveries: QuarantinedDelivery[] }> {
	const current = await configurationState(store);
	return {
		revision: current.revision,
		deliveries: await store.quarantinedWebhooks(accountId, current.revision),
	};
}

/** Put one of the account's quarantined deliveries back in the inbox. */
export async function retryQuarantinedDelivery(
	store: AccountOperationsStore,
	accountId: string,
	expectedRevision: number,
	deliveryId: string,
): Promise<void> {
	if (
		!(await store.retryQuarantinedWebhook(
			accountId,
			expectedRevision,
			deliveryId,
		))
	)
		throw new ControlError(404, "quarantined delivery not found");
}
