import {
	type BindleDeploymentRequest,
	type BrokerCatalog,
	type ContentHash,
	type HostingQuote,
	prepareYardHostingWork,
} from "../src/index.js";

export function bindTestYardWork(
	quote: HostingQuote,
	request: BindleDeploymentRequest,
	brokerId: string,
	catalog: BrokerCatalog,
	overrides?: {
		yardId?: string;
		providerId?: string;
		generationPlanHash?: ContentHash;
	},
): void {
	const plan = prepareYardHostingWork({
		request,
		brokerId,
		ownerTenantId: quote.ownerTenantId,
		catalog,
		yardId: overrides?.yardId ?? quote.yardId,
		providerId: overrides?.providerId ?? quote.providerId,
		generationPlanHash: overrides?.generationPlanHash,
	});
	if ("error" in plan) throw new Error(`test quote work: ${plan.error}`);
	quote.workDigest = plan.workDigest;
}
