import { parseBetterAuthSecretRef } from "@hobo/auth-adapter-contract";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "@hobo/auth-adapter-contract/json";

import { BetterAuthBundlePlanError } from "./errors.js";

const BINDLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface BetterAuthBundlePortRefs {
	readonly relationalBindle: string;
	readonly httpBindle: string;
	readonly signingSecretRef: string;
}

function refuse(
	code: BetterAuthBundlePlanError["code"],
	message: string,
	remediation: string,
): never {
	throw new BetterAuthBundlePlanError(code, message, remediation);
}

function readPortString(record: JsonObject, field: string): string {
	if (!Object.hasOwn(record, field) || record[field] === undefined) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_MISSING",
			`bundle port ${field} is missing`,
			`set ${field} to a non-empty string on BetterAuthBundlePortRefs`,
		);
	}
	const value = record[field];
	if (!isJsonString(value) || value.length === 0) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			`bundle port ${field} must be a non-empty string`,
			`set ${field} to a non-empty string before trimming`,
		);
	}
	return value.trim();
}

export function parseBetterAuthBundlePortRefs(
	input: unknown,
): BetterAuthBundlePortRefs {
	if (!isJsonObject(input)) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"Better Auth bundle ports must be a JSON object",
			"pass relationalBindle, httpBindle, and signingSecretRef as strings",
		);
	}
	const relationalBindle = readPortString(input, "relationalBindle");
	const httpBindle = readPortString(input, "httpBindle");
	const signingSecretRef = readPortString(input, "signingSecretRef");
	if (!BINDLE_NAME.test(relationalBindle) || !BINDLE_NAME.test(httpBindle)) {
		refuse(
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
