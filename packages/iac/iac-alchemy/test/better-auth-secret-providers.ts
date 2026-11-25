export const BETTER_AUTH_SECRET_PROVIDER_STACK = Object.freeze([
	"dotenv",
	"infisical",
] as const);

export type BetterAuthSecretProviderId = (typeof BETTER_AUTH_SECRET_PROVIDER_STACK)[number];

export function resolveBetterAuthSecretProviderStack(options: {
	readonly stage: string;
}): readonly BetterAuthSecretProviderId[] {
	if (options.stage === "ci" || options.stage.startsWith("ci-")) {
		return BETTER_AUTH_SECRET_PROVIDER_STACK;
	}
	return Object.freeze(["dotenv"] as const);
}

export function mergeBetterAuthConstructionDotEnv(
	base: Readonly<Record<string, string>>,
	overlay: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return Object.freeze({ ...base, ...overlay });
}