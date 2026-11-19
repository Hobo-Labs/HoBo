import type { VerifiedSourceRef } from "./sponsored-transfer.js";
import { VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID } from "./sponsored-transfer.js";

// public-contract: stable Vercel Drop Resource Definition identifier.
export const VERCEL_DROP_DEFINITION_ID = "vercel.drop-station/v1";

export type DropClassification = {
	readonly definitionId: typeof VERCEL_DROP_DEFINITION_ID;
	readonly separateFromDefinitionId: typeof VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID;
	readonly bootstrapClass: "anonymous-claimable";
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
