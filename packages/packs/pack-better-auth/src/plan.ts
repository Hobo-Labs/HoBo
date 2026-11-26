import {
	assertBetterAuthRuntimeAvailable,
	BETTER_AUTH_DESCRIPTOR,
	type BetterAuthConfig,
	parseBetterAuthConfig,
} from "@hobo/auth-adapter-contract";
import type { JsonValue } from "@hobo/core";

import { BETTER_AUTH_PACK_ID } from "./catalog.js";
import { BetterAuthBundlePlanError } from "./errors.js";
import {
	type BetterAuthBundlePortRefs,
	parseBetterAuthBundlePortRefs,
} from "./ports.js";

export interface BetterAuthBundlePlan {
	readonly packId: typeof BETTER_AUTH_PACK_ID;
	readonly descriptorId: string;
	readonly claimsMappingVersion: string;
	readonly requiredPorts: readonly string[];
	readonly config: BetterAuthConfig;
	readonly ports: BetterAuthBundlePortRefs;
	readonly routePattern: string;
}

function refuse(
	code: BetterAuthBundlePlanError["code"],
	message: string,
	remediation: string,
): never {
	throw new BetterAuthBundlePlanError(code, message, remediation);
}

export function planBetterAuthBundle(
	configInput: JsonValue,
	portsInput: BetterAuthBundlePortRefs,
	options?: {
		readonly runtimePresent?: boolean;
		readonly forExecution?: boolean;
	},
): BetterAuthBundlePlan {
	const config = parseBetterAuthConfig(configInput);
	const ports = parseBetterAuthBundlePortRefs(portsInput);
	if (ports.signingSecretRef !== config.secretRef) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"the signing secret locator on the bundle ports does not match the parsed auth config",
			"set ports.signingSecretRef to the same locator as config.secretRef",
		);
	}
	for (const port of BETTER_AUTH_DESCRIPTOR.requiredPorts) {
		const bound =
			port === "hobo:data/relational"
				? ports.relationalBindle
				: port === "hobo:http"
					? ports.httpBindle
					: port === "hobo:secrets"
						? ports.signingSecretRef.length > 0
						: false;
		if (!bound) {
			refuse(
				"BETTER_AUTH_BUNDLE_PORT_MISSING",
				`required port ${port} is not wired on this bundle plan`,
				`declare a bindle for ${port} and pass its name through BetterAuthBundlePortRefs`,
			);
		}
	}
	if (options?.forExecution === true) {
		assertBetterAuthRuntimeAvailable(
			options.runtimePresent === undefined
				? undefined
				: { runtimePresent: options.runtimePresent },
		);
	}
	const routePattern = `${config.basePath}/*`;
	return Object.freeze({
		packId: BETTER_AUTH_PACK_ID,
		descriptorId: BETTER_AUTH_DESCRIPTOR.id,
		claimsMappingVersion: BETTER_AUTH_DESCRIPTOR.claimsMappingVersion,
		requiredPorts: BETTER_AUTH_DESCRIPTOR.requiredPorts,
		config,
		ports,
		routePattern,
	});
}
