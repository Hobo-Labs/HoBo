export type BetterAuthBundlePlanErrorCode =
	| "BETTER_AUTH_BUNDLE_PORT_MISSING"
	| "BETTER_AUTH_BUNDLE_PORT_INVALID"
	| "BETTER_AUTH_SIGNING_SECRET_UNRESOLVED"
	| "BETTER_AUTH_SIGNING_SECRET_WEAK";

export class BetterAuthBundlePlanError extends Error {
	readonly code: BetterAuthBundlePlanErrorCode;

	constructor(
		code: BetterAuthBundlePlanErrorCode,
		message: string,
		readonly remediation: string,
	) {
		super(message);
		this.name = "BetterAuthBundlePlanError";
		this.code = code;
	}
}
