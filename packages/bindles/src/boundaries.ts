import type { BindleDefinition } from "./types.js";

// Domain and provider boundaries for a Bindle placed in a Yard (the Yard rule
// is @hobo/yards `yardBoundaryViolations`): a Yard holds nothing external. A
// Bindle's `b.external()` names a service someone else runs; placed in a Yard,
// it would make that Yard hold it. A `managedBy` declaration alone cannot
// establish that the chosen provider manages it; placement has no trusted
// marketplace evidence yet. Refuse until that relationship can be verified.
// `hobo dev` is unaffected: nothing is placed in a Yard there.

export interface ExternalBoundaryViolation {
	readonly resource: string;
	readonly message: string;
	readonly remediation: string;
}

/** `b.external()` resources a Yard would hold across its provider boundary. */
export function externalBoundaryViolations(
	definition: BindleDefinition,
): ExternalBoundaryViolation[] {
	return Object.entries(definition.resources)
		.filter(([, record]) => record.kind === "external")
		.map(([name]) => ({
			resource: name,
			message: `Bindle ${definition.name} declares ${name} as external; a Yard holds nothing external`,
			remediation: `Declare ${name} in a Yard whose provider runs it and join that Yard to this one with a junction. A managedBy annotation alone does not verify a Marketplace relationship.`,
		}))
		.sort((a, b) => a.resource.localeCompare(b.resource));
}
