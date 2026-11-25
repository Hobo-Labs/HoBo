import { BETTER_AUTH_ADAPTER_ID } from "@hobo/auth-adapter-contract";

import type { BetterAuthBundlePlan } from "./plan.js";

// parallel-type-allowed: snake_case durable projection for CUE vet until pack_better_auth buf codegen lands in the migrations slice.
export interface BetterAuthBundlePlanRecord {
	readonly pack_id: string;
	readonly descriptor_id: string;
	readonly claims_mapping_version: string;
	readonly required_ports: readonly string[];
	readonly adapter_id: string;
	readonly base_path: string;
	readonly route_pattern: string;
	readonly ports: {
		readonly relational_bindle: string;
		readonly http_bindle: string;
		readonly signing_secret_ref: string;
	};
}

export function toBetterAuthBundlePlanRecord(
	plan: BetterAuthBundlePlan,
): BetterAuthBundlePlanRecord {
	return Object.freeze({
		pack_id: plan.packId,
		descriptor_id: plan.descriptorId,
		claims_mapping_version: plan.claimsMappingVersion,
		required_ports: [...plan.requiredPorts],
		adapter_id: BETTER_AUTH_ADAPTER_ID,
		base_path: plan.config.basePath,
		route_pattern: plan.routePattern,
		ports: Object.freeze({
			relational_bindle: plan.ports.relationalBindle,
			http_bindle: plan.ports.httpBindle,
			signing_secret_ref: plan.ports.signingSecretRef,
		}),
	});
}