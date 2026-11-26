import { fromJsonString } from "@bufbuild/protobuf";
import {
	type AccountState,
	type BudgetSignal,
	BudgetSignalSchema,
	ciBudgetSignalUpdate,
} from "@hobo/ci";
import type { CiBudgetRoutingOutcome } from "./ci-routing.js";

/** Account-scoped v2 relay port. The credential needs observations:write. */
export interface HostedCiBudgetRoutingClient {
	getSignalState(): Promise<AccountState>;
	publishBudgetSignal(
		signal: BudgetSignal,
		options: { revision: number },
	): Promise<AccountState>;
}

/** Publish Broker's facts; hosted policy and provider state stay owned by the relay. */
export function createHostedCiBudgetRoutingBridge(options: {
	accountId: string;
	tenantId: string;
	client: HostedCiBudgetRoutingClient;
}) {
	if (
		!/^[a-zA-Z0-9_-]{1,80}$/.test(options.accountId) ||
		!/^[a-zA-Z0-9_-]{1,80}$/.test(options.tenantId)
	)
		throw new Error("invalid CI routing account or tenant");
	return Object.freeze({
		async accept(
			serializedBrokerFact: string,
		): Promise<CiBudgetRoutingOutcome> {
			const signal = fromJsonString(BudgetSignalSchema, serializedBrokerFact);
			if (!signal.data || signal.data.tenantId !== options.tenantId)
				throw new Error("foreign CI budget signal");
			// Each retry rereads the current account revision; replay is idempotent at the relay.
			for (let attempt = 0; attempt < 5; attempt++) {
				const current = await options.client.getSignalState();
				if (current.account?.id !== options.accountId)
					throw new Error("CI routing account does not match relay policy");
				if (
					!ciBudgetSignalUpdate(signal, {
						tenantId: options.tenantId,
						budgetPolicy: current.account.budgetPolicy,
					})
				)
					throw new Error("invalid or foreign CI budget signal");
				try {
					const saved = await options.client.publishBudgetSignal(signal, {
						revision: current.revision,
					});
					return {
						changed: saved.revision !== current.revision,
						revision: saved.revision,
					};
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"status" in error &&
							error.status === 409
						) ||
						attempt === 4
					)
						throw error;
				}
			}
			throw new Error("unreachable CI signal retry state");
		},
	});
}
