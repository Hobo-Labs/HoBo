import type { RejectionPlane } from "./types.js";

// The rejection matrix (the HOBO-528 evidence requirement, now runtime): the
// closed catalog of rejection codes the broker may emit, each pinned to the
// plane that owns it and a remediation an agent can act on. broker.test.ts
// asserts every reject path emits a cataloged code, so the matrix can never
// silently drift from the pipeline.

export interface RejectionMatrixRow {
	code: string;
	plane: RejectionPlane;
	remediation: string;
}

// public-contract: the closed rejection-code catalog agents self-correct against.
export const REJECTION_MATRIX: readonly RejectionMatrixRow[] = [
	{
		code: "invalid-spend-estimate",
		plane: "billing",
		remediation:
			"supply a finite nonnegative estimate and stable request identity",
	},
	{
		code: "reservation-replay-mismatch",
		plane: "billing",
		remediation:
			"use a new request identity for changed work; reconcile the existing reservation",
	},
	{
		code: "metering-evidence-incomplete",
		plane: "billing",
		remediation:
			"reconcile unknown charges and restore a complete monotonic metering stream before spending",
	},
	{
		code: "hosting-budget-admission-denied",
		plane: "billing",
		remediation:
			"supply fresh scoped bounded quotes, fulfilled policy evidence and an affordable durable shared reservation",
	},
	{
		code: "yard-generation-uncertain",
		plane: "placement",
		remediation:
			"inspect and reconcile the existing generation attempt; retain its budget commitment until positively settled",
	},
	{
		code: "connector-missing",
		plane: "connectors",
		remediation:
			"register and enable a connector of the required kind (hobo add / connector registry) before resolving",
	},
	{
		code: "no-placement-policy",
		plane: "policy",
		remediation:
			"configure a placement policy whose scope kind applies to the request's topology scope",
	},
	{
		code: "explicit-camp-required",
		plane: "policy",
		remediation:
			"name an explicit, approved camp in the request scope — junction governance has locked camp inference off",
	},
	{
		code: "policy-denied",
		plane: "policy",
		remediation:
			"the policy pack or Rego decision denied the action; change the request or amend the policy through governance",
	},
	{
		code: "policy-engine-unavailable",
		plane: "policy",
		remediation:
			"the external policy engine (OPA) could not be reached; the broker fails closed — restore the engine or fall back to the in-proc pack",
	},
	{
		code: "approval-required",
		plane: "policy",
		remediation:
			"obtain the required approval (or satisfy pending obligations) and resubmit",
	},
	{
		code: "obligation-pending",
		plane: "policy",
		remediation: "satisfy the named obligations before apply and resubmit",
	},
	{
		code: "quota-exceeded",
		plane: "billing",
		remediation:
			"the deployment quota is exhausted; wait for the quota window or raise the limit through billing governance",
	},
	{
		code: "spend-cap-exceeded",
		plane: "billing",
		remediation:
			"lower the spend estimate or raise the per-resolution spend cap in the billing policy",
	},
	{
		code: "budget-exceeded",
		plane: "billing",
		remediation:
			"the remaining budget (static or metered) cannot cover the estimate; adjust the budget or reduce scope",
	},
	{
		code: "environment-unapproved",
		plane: "policy",
		remediation:
			"the broker environment is published but not approved; an admin must approve it before resolutions run against it",
	},
	{
		code: "catalog-snapshot-stale",
		plane: "policy",
		remediation:
			"the environment pins a catalog snapshot that no longer matches the live catalog; republish the environment against the current snapshot or refresh the catalog",
	},
	{
		code: "no-eligible-provider",
		plane: "placement",
		remediation:
			"no approved provider satisfies the port/features/region under the effective policy; approve a provider, widen allowed regions, or drop the feature requirement",
	},
	{
		code: "pinned-provider-unavailable",
		plane: "placement",
		remediation:
			"the pinned provider cannot satisfy the requirement; unpin the objective or pin a provider that advertises the capability",
	},
] as const;

const CODES = new Map(REJECTION_MATRIX.map((row) => [row.code, row]));

export function rejectionMatrixRow(
	code: string,
): RejectionMatrixRow | undefined {
	return CODES.get(code);
}

export function isCatalogedRejectionCode(code: string): boolean {
	return CODES.has(code);
}
