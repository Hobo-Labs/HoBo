export type BetterAuthBundlePlanErrorCode =
	| "BETTER_AUTH_BUNDLE_PORT_MISSING"
	| "BETTER_AUTH_BUNDLE_PORT_INVALID";

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