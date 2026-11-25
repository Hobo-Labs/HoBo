import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
	VercelAlias,
	VercelProject,
	type VercelRuntimeKind,
	VercelServiceDeployment,
} from "./provider.js";

export type DualCloudEdgeProvider = "vercel" | "cloudflare";

export interface DualCloudServiceOffer {
	readonly provider: DualCloudEdgeProvider;
	readonly backendId: string;
	readonly endpointUrl: string;
	readonly remainingCreditsMicros: number;
	readonly estimatedMonthlyCostMicros: number;
	readonly healthy: boolean;
}

export interface BudgetRoutingDecision {
	readonly selectedProvider: DualCloudEdgeProvider;
	readonly selectedBackendId: string;
	readonly fallbackProvider: DualCloudEdgeProvider | undefined;
	readonly netCostMicros: number;
	readonly reason:
		| "credits-preferred"
		| "lowest-cost-within-budget"
		| "incumbent-held-hysteresis";
}

export class DualCloudBudgetRouterError extends Data.TaggedError(
	"DualCloudBudgetRouterError",
)<{
	readonly reason: "budget-exhausted" | "no-healthy-offers";
	readonly message: string;
}> {}

export function selectDualCloudBudgetTarget(input: {
	readonly offers: readonly DualCloudServiceOffer[];
	readonly budgetCeilingMicros: number;
	readonly incumbentProvider?: DualCloudEdgeProvider;
	readonly minSavingsToSwitchMicros?: number;
}): BudgetRoutingDecision {
	const healthy = input.offers.filter((offer) => offer.healthy);
	const scored = healthy
		.map((offer) => {
			const netCostMicros = Math.max(
				0,
				offer.estimatedMonthlyCostMicros - offer.remainingCreditsMicros,
			);
			return { offer, netCostMicros };
		})
		.filter((entry) => entry.netCostMicros <= input.budgetCeilingMicros)
		.sort((left, right) => {
			if (left.netCostMicros !== right.netCostMicros) {
				return left.netCostMicros - right.netCostMicros;
			}
			if (
				left.offer.remainingCreditsMicros !== right.offer.remainingCreditsMicros
			) {
				return (
					right.offer.remainingCreditsMicros - left.offer.remainingCreditsMicros
				);
			}
			return left.offer.provider.localeCompare(right.offer.provider);
		});

	const best = scored[0];
	if (best === undefined) {
		if (healthy.length === 0) {
			throw new DualCloudBudgetRouterError({
				reason: "no-healthy-offers",
				message:
					"dual-cloud budget router refuses to select from zero healthy offers",
			});
		}
		throw new DualCloudBudgetRouterError({
			reason: "budget-exhausted",
			message:
				"dual-cloud budget router refuses to select an offer above the budget ceiling",
		});
	}

	const incumbent =
		input.incumbentProvider !== undefined
			? scored.find((entry) => entry.offer.provider === input.incumbentProvider)
			: undefined;
	const minSavings = input.minSavingsToSwitchMicros ?? 0;
	if (
		incumbent !== undefined &&
		incumbent.offer.provider !== best.offer.provider &&
		incumbent.netCostMicros - best.netCostMicros < minSavings
	) {
		return {
			selectedProvider: incumbent.offer.provider,
			selectedBackendId: incumbent.offer.backendId,
			fallbackProvider: best.offer.provider,
			netCostMicros: incumbent.netCostMicros,
			reason: "incumbent-held-hysteresis",
		};
	}

	const fallback = scored[1];
	return {
		selectedProvider: best.offer.provider,
		selectedBackendId: best.offer.backendId,
		fallbackProvider: fallback?.offer.provider,
		netCostMicros: best.netCostMicros,
		reason:
			best.offer.remainingCreditsMicros > 0
				? "credits-preferred"
				: "lowest-cost-within-budget",
	};
}

export interface VercelServiceStackInput {
	readonly projectId: string;
	readonly projectName: string;
	readonly serviceName: string;
	readonly artifactDigest: string;
	readonly domain: string;
	readonly runtime?: VercelRuntimeKind;
	readonly regions?: readonly string[];
	readonly credentialConfigKey?: string;
	readonly credentialLocator?: string;
}

export function declareVercelServiceStack(input: VercelServiceStackInput) {
	return Effect.gen(function* () {
		const project = yield* VercelProject(input.projectId, {
			name: input.projectName,
			gitLink: "disabled",
			...(input.regions !== undefined ? { regions: input.regions } : undefined),
			...(input.credentialConfigKey !== undefined
				? { credentialConfigKey: input.credentialConfigKey }
				: undefined),
			...(input.credentialLocator !== undefined
				? { credentialLocator: input.credentialLocator }
				: undefined),
		});
		const deployment = yield* VercelServiceDeployment(
			`${input.projectId}-deploy`,
			{
				projectId: project.projectId,
				serviceName: input.serviceName,
				artifactDigest: input.artifactDigest,
				...(input.runtime !== undefined
					? { runtime: input.runtime }
					: undefined),
				...(input.regions !== undefined
					? { regions: input.regions }
					: undefined),
				...(input.credentialConfigKey !== undefined
					? { credentialConfigKey: input.credentialConfigKey }
					: undefined),
				...(input.credentialLocator !== undefined
					? { credentialLocator: input.credentialLocator }
					: undefined),
			},
		);
		const alias = yield* VercelAlias(`${input.projectId}-alias`, {
			deploymentId: deployment.deploymentId,
			domain: input.domain,
			...(input.credentialConfigKey !== undefined
				? { credentialConfigKey: input.credentialConfigKey }
				: undefined),
			...(input.credentialLocator !== undefined
				? { credentialLocator: input.credentialLocator }
				: undefined),
		});
		return {
			provider: "vercel" as const,
			gitLink: project.gitLink,
			projectId: project.projectId,
			deploymentId: deployment.deploymentId,
			url: alias.url,
		};
	});
}
