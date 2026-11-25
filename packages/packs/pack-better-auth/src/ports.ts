import { parseBetterAuthSecretRef } from "@hobo/auth-adapter-contract";

import { BetterAuthBundlePlanError } from "./errors.js";

const BINDLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface BetterAuthBundlePortRefs {
	readonly relationalBindle: string;
	readonly httpBindle: string;
	readonly signingSecretRef: string;
}

export function parseBetterAuthBundlePortRefs(
	input: BetterAuthBundlePortRefs,
): BetterAuthBundlePortRefs {
	const relationalBindle = input.relationalBindle.trim();
	const httpBindle = input.httpBindle.trim();
	const signingSecretRef = input.signingSecretRef.trim();
	if (!BINDLE_NAME.test(relationalBindle) || !BINDLE_NAME.test(httpBindle)) {
		throw new BetterAuthBundlePlanError(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"relationalBindle and httpBindle must be lowercase DNS labels with underscores allowed",
			"pass auth_db / auth_api style bindle names through BetterAuthBundlePortRefs",
		);
	}
	return Object.freeze({
		relationalBindle,
		httpBindle,
		signingSecretRef: parseBetterAuthSecretRef(signingSecretRef),
	});
}