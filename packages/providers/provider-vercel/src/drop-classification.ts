/**
 * Vercel Drop is a different product, and it is not anonymous deployment.
 *
 * Drop takes uploaded files and produces a live project without a Git repo, but
 * the resulting project has to be claimed into a Vercel account, and the CLI
 * Drop-equivalent in `./temporary-station.js` runs against a `vercel login`
 * session. So Drop's bootstrap class is `anonymous-claimable` at most — never
 * `public-anonymous`, and never the same definition as
 * `vercel.sponsored-project-transfer/v1`.
 *
 * This file exists because that distinction gets flattened every time someone
 * summarizes "no account needed to see the URL" as "no account needed".
 */
import type { VerifiedSourceRef } from "./sponsored-transfer.js";
import { VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID } from "./sponsored-transfer.js";

// public-contract: stable Vercel Drop Resource Definition identifier.
export const VERCEL_DROP_DEFINITION_ID = "vercel.drop-station/v1";

export type DropClassification = {
	readonly definitionId: typeof VERCEL_DROP_DEFINITION_ID;
	/** Distinct from the sponsored strategy. Asserted by test. */
	readonly separateFromDefinitionId: typeof VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID;
	readonly bootstrapClass: "anonymous-claimable";
	/** Whether a live deployment can be kept without any Vercel account. */
	readonly accountRequiredToRetain: true;
	readonly directAnonymousDeployment: false;
	readonly rationale: string;
	readonly sources: readonly VerifiedSourceRef[];
};

export const VERCEL_DROP_CLASSIFICATION: DropClassification = Object.freeze({
	definitionId: VERCEL_DROP_DEFINITION_ID,
	separateFromDefinitionId: VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
	bootstrapClass: "anonymous-claimable",
	accountRequiredToRetain: true,
	directAnonymousDeployment: false,
	rationale:
		"A Drop deployment produces a project that must be claimed into a Vercel account to be kept or managed, and the CLI equivalent deploys through an existing login session. Publishing a URL without signing in first is not the same as owning infrastructure without an account.",
	sources: Object.freeze([
		Object.freeze({
			url: "https://vercel.com/docs/deployments/claim-deployments",
			checkedOn: "2026-08-08",
			note: "claiming a deployment means transferring it into a Vercel account the human selects; there is no accountless retention path",
		}),
	]),
});
