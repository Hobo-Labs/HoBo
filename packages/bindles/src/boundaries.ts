import type { BindleDefinition } from "./types.js";

export interface ExternalBoundaryViolation {
	readonly resource: string;
	readonly message: string;
	readonly remediation: string;
}

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
