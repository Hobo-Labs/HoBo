import { looksLikeSecret } from "../runner-integrations.js";

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
const OWNER_REFERENCE = /^owner:\/\/[A-Z][A-Z0-9_]{0,63}$/u;

// public-contract: the scope a provider usage credential is resolved for in the owner's store session.
export const PROVIDER_USAGE_CREDENTIAL_SCOPE = "hobo-ci-provider-usage";

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
	if (!OWNER_REFERENCE.test(credential))
		throw new Error(
			looksLikeSecret(credential)
				? `the ${provider} credential looks like a token; give an owner-store reference such as owner://${provider.toUpperCase()}_USAGE_TOKEN, never a token value`
				: `the ${provider} credential must be an owner-store reference such as owner://${provider.toUpperCase()}_USAGE_TOKEN`,
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

export type OwnerCredentialSource = Readonly<{
	resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>>;
}>;

export function ownerStoreCredentialResolver(
	source: OwnerCredentialSource,
): CredentialResolver {
	return async (reference) => {
		if (!OWNER_REFERENCE.test(reference)) return undefined;
		const material = await source
			.resolve(reference, PROVIDER_USAGE_CREDENTIAL_SCOPE)
			.catch(() => undefined);
		const token = material?.token?.trim();
		return token === undefined || token === "" ? undefined : token;
	};
}
