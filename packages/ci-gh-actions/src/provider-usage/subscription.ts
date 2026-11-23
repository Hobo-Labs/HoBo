import { looksLikeSecret, SECRET_REFERENCE } from "../runner-integrations.js";

// public-contract: the hosted providers whose own usage API HoBo reads.
export const USAGE_SYNC_PROVIDERS = [
	"depot",
	"namespace",
	"warpbuild",
] as const;
export type UsageSyncProvider = (typeof USAGE_SYNC_PROVIDERS)[number];

// public-contract: the default Namespace compute region.
export const NAMESPACE_DEFAULT_REGION = "us";

export type ProviderUsageSubscription = Readonly<{
	accountId: string;
	provider: UsageSyncProvider;
	credential: string;
	region: string | undefined;
}>;

export type ProviderUsageSubscriptionInput = Readonly<{
	accountId: string;
	provider: string;
	credential: string;
	region?: string | undefined;
}>;

const REGION = /^[a-z]{2,8}$/u;

function usageProvider(text: string): UsageSyncProvider | undefined {
	const lower = text.trim().toLowerCase();
	return USAGE_SYNC_PROVIDERS.find((provider) => provider === lower);
}

export function parseProviderUsageSubscription(
	input: ProviderUsageSubscriptionInput,
): ProviderUsageSubscription {
	const accountId = input.accountId.trim();
	if (accountId === "")
		throw new Error("a provider usage subscription needs an account id");
	const provider = usageProvider(input.provider);
	if (provider === undefined)
		throw new Error(
			`usage is synced only from ${USAGE_SYNC_PROVIDERS.join(", ")}, not "${input.provider}"`,
		);
	const credential = input.credential.trim();
	if (!SECRET_REFERENCE.test(credential))
		throw new Error(
			looksLikeSecret(credential)
				? `the ${provider} credential looks like a token; give a reference such as env:${provider.toUpperCase()}_USAGE_TOKEN, never a token value`
				: `the ${provider} credential must be a reference such as env:${provider.toUpperCase()}_USAGE_TOKEN`,
		);
	if (provider !== "namespace") {
		if (input.region !== undefined)
			throw new Error(`only a namespace subscription names a region`);
		return Object.freeze({
			accountId,
			provider,
			credential,
			region: undefined,
		});
	}
	const region = (input.region ?? NAMESPACE_DEFAULT_REGION)
		.trim()
		.toLowerCase();
	if (!REGION.test(region))
		throw new Error(`"${region}" is not a Namespace region such as us or eu`);
	return Object.freeze({ accountId, provider, credential, region });
}

export type CredentialResolver = (
	reference: string,
) => Promise<string | undefined>;

export function envCredentialResolver(
	env: NodeJS.ProcessEnv,
): CredentialResolver {
	return async (reference) => {
		const match = /^env:([A-Z][A-Z0-9_]{0,63})$/u.exec(reference);
		if (!match?.[1]) return undefined;
		const value = env[match[1]]?.trim();
		return value === undefined || value === "" ? undefined : value;
	};
}
