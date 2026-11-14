import { readDependencyConfig } from "./dependencies.js";
import { isJsonObject, isJsonString } from "./json.js";
import type { BindleDefinition } from "./types.js";

// Domain and provider boundaries for a Bindle placed in a Yard (the Yard rule
// is @hobo/yards `yardBoundaryViolations`): a Yard holds nothing external. A
// Bindle's `b.external()` names a service someone else runs; placed in a Yard,
// it would make that Yard hold it. So an external is refused at placement
// unless the provider runs it for us (`managedBy`, e.g. Neon or Supabase
// through the Vercel Marketplace). Anything else belongs to a Yard of its own,
// joined to this one by a junction. `hobo dev` is unaffected: nothing is
// placed in a Yard there.

export interface ExternalBoundaryViolation {
	readonly resource: string;
	readonly message: string;
	readonly remediation: string;
}

function managedProvider(
	definition: BindleDefinition,
	resource: string,
): string | undefined {
	const record = definition.resources[resource];
	if (record === undefined) return undefined;
	const config = readDependencyConfig(record.annotations);
	const managedBy = config?.managedBy;
	if (!isJsonObject(managedBy)) return undefined;
	return isJsonString(managedBy.provider) && managedBy.via === "marketplace"
		? managedBy.provider
		: undefined;
}

/** `b.external()` resources a Yard would hold across its provider boundary. */
export function externalBoundaryViolations(
	definition: BindleDefinition,
): ExternalBoundaryViolation[] {
	return Object.entries(definition.resources)
		.filter(([, record]) => record.kind === "external")
		.filter(([name]) => managedProvider(definition, name) === undefined)
		.map(([name]) => ({
			resource: name,
			message: `Bindle ${definition.name} declares ${name} as external; a Yard holds nothing external`,
			remediation: `Declare ${name} in a Yard whose provider runs it and join that Yard to this one with a junction; or, if the provider you deploy to runs it for you (a Marketplace resource), declare it with b.external({ managedBy: { provider, via: "marketplace" } }).`,
		}))
		.sort((a, b) => a.resource.localeCompare(b.resource));
}
