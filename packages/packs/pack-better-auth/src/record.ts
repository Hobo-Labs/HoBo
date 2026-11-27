import {
	type AUTH_ADAPTER_CONTRACT,
	BETTER_AUTH_ADAPTER_ID,
	type BetterAuthConfig,
} from "@hobo/auth-adapter-contract";

import type { BetterAuthBundlePlan } from "./plan.js";

// parallel-type-allowed: BetterAuth*Record types are snake_case CUE replay JSON; *_pb.ts Messages use camelCase wire accessors.
export interface BetterAuthParsedConfigRecord {
	readonly contract: typeof AUTH_ADAPTER_CONTRACT;
	readonly adapter_id: typeof BETTER_AUTH_ADAPTER_ID;
	readonly base_path: string;
	readonly secret_ref: string;
	readonly database_profile: string;
	readonly email_and_password_enabled: boolean;
	readonly social_providers: readonly string[];
	readonly organizations_enabled: boolean;
}

// parallel-type-allowed: snake_case CUE replay JSON for pack_better_auth.cue vetting.
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
	readonly parsed_config: BetterAuthParsedConfigRecord;
}

function toParsedConfigRecord(
	config: BetterAuthConfig,
): BetterAuthParsedConfigRecord {
	return Object.freeze({
		contract: config.contract,
		adapter_id: config.adapterId,
		base_path: config.basePath,
		secret_ref: config.secretRef,
		database_profile: config.database.profile,
		email_and_password_enabled: config.emailAndPassword.enabled,
		social_providers: Object.freeze([...config.socialProviders]),
		organizations_enabled: config.organizations.enabled,
	});
}

export function toBetterAuthBundlePlanRecord(
	plan: BetterAuthBundlePlan,
): BetterAuthBundlePlanRecord {
	const parsedConfig = toParsedConfigRecord(plan.config);
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
		parsed_config: parsedConfig,
	});
}
