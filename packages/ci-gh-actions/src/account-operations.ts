import type { ConfigurationState, Lease, QuarantinedWebhook } from "@hobo/ci";
import type { HostedRelay, HostedRelayStore } from "./hosted-relay.js";

export class ControlError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export type QuarantinedDelivery = QuarantinedWebhook;

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

export async function configurationState(
	store: Pick<HostedRelayStore, "configuration">,
): Promise<ConfigurationState> {
	const result = await store.configuration();
	if (!result?.configuration)
		throw new ControlError(503, "configuration unavailable");
	return result;
}

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
