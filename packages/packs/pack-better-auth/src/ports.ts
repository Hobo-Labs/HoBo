const BINDLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

const SECRET_LOCATOR = /^[a-z][a-z0-9+.-]{1,31}:\/\/.+/u;

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
	if (
		!BINDLE_NAME.test(relationalBindle) ||
		!BINDLE_NAME.test(httpBindle) ||
		!SECRET_LOCATOR.test(signingSecretRef)
	) {
		throw new Error("invalid better-auth bundle port refs");
	}
	return Object.freeze({
		relationalBindle,
		httpBindle,
		signingSecretRef,
	});
}