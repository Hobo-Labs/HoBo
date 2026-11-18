
export interface PriorPlacement {
	readonly deploymentId: string;
	readonly resource: string;
	readonly region: string;
	readonly catalogContentHash: string;
	readonly objective: string;
}

export interface ReplacementInputs {
	readonly prior: PriorPlacement;
	readonly catalogContentHash: string;
	readonly objective: string;
	readonly residencyOk?: boolean;
	readonly permittedRegions?: readonly string[];
	readonly interruptible?: boolean;
}

export type ReplacementReason =
	| "catalog-changed"
	| "objective-changed"
	| "residency-violated"
	| "no-permitted-region";

export type ReplacementAction = "hold" | "re-decide" | "blocked";

export interface ReplacementVerdict {
	readonly action: ReplacementAction;
	readonly reasons: readonly ReplacementReason[];
	readonly prior: PriorPlacement;
	readonly forced: boolean;
	readonly deferred: boolean;
}

export function evaluateReplacement(
	input: ReplacementInputs,
): ReplacementVerdict {
	const reasons: ReplacementReason[] = [];

	const residencyOk = input.residencyOk ?? true;
	if (!residencyOk) reasons.push("residency-violated");

	if (input.catalogContentHash !== input.prior.catalogContentHash)
		reasons.push("catalog-changed");
	if (input.objective !== input.prior.objective)
		reasons.push("objective-changed");

	const forced = !residencyOk;
	const opportunity = reasons.some(
		(reason) => reason === "catalog-changed" || reason === "objective-changed",
	);

	const nowhereLawful =
		input.permittedRegions !== undefined && input.permittedRegions.length === 0;

	let action: ReplacementAction;
	let deferred = false;

	if (forced || opportunity) {
		if (nowhereLawful) {
			reasons.push("no-permitted-region");
			action = "blocked";
		} else if (forced) {
			action = "re-decide";
		} else if (input.interruptible === true) {
			action = "re-decide";
		} else {
			action = "hold";
			deferred = true;
		}
	} else {
		action = "hold";
	}

	reasons.sort();

	return {
		action,
		reasons,
		prior: input.prior,
		forced,
		deferred,
	};
}
