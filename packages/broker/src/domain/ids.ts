import * as Schema from "effect/Schema";

export const BudgetAccountId = Schema.String.pipe(
	Schema.brand("BudgetAccountId"),
);
export type BudgetAccountId = typeof BudgetAccountId.Type;

export const BudgetHoldId = Schema.String.pipe(Schema.brand("BudgetHoldId"));
export type BudgetHoldId = typeof BudgetHoldId.Type;

export const BudgetEpochMs = Schema.Int;
export type BudgetEpochMs = typeof BudgetEpochMs.Type;

export const ProviderConnectionId = Schema.String.pipe(
	Schema.brand("ProviderConnectionId"),
);
export type ProviderConnectionId = typeof ProviderConnectionId.Type;

export const ConnectionLifecycleState = Schema.Literals([
	"uninitialized",
	"authorized",
	"revoked",
]);
export type ConnectionLifecycleState = typeof ConnectionLifecycleState.Type;
