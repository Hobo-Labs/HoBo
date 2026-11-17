/**
 * Which hosted providers an account syncs usage from, and where each one's
 * token lives (ADR-0183).
 *
 * A subscription holds a credential reference, never a credential: `env:NAME`
 * names an environment variable of the process that runs the sync, the same
 * reference form runner integrations use (`SECRET_REFERENCE`). A value that
 * looks like a token is refused when the subscription is parsed, so it can
 * never be kept. The token is resolved for each sync and dropped after the
 * call.
 */
import { looksLikeSecret, SECRET_REFERENCE } from "../runner-integrations.js";

// public-contract: the hosted providers whose own usage API HoBo reads.
export const USAGE_SYNC_PROVIDERS = [
	"depot",
	"namespace",
	"warpbuild",
] as const;
export type UsageSyncProvider = (typeof USAGE_SYNC_PROVIDERS)[number];

/** The Namespace region a subscription reads when it names none. */
// public-contract: the default Namespace compute region.
export const NAMESPACE_DEFAULT_REGION = "us";

export type ProviderUsageSubscription = Readonly<{
	accountId: string;
	provider: UsageSyncProvider;
	/** Where the read-only token lives, as `env:NAME` or `github-secret:NAME`. */
	credential: string;
	/** Namespace's compute region; undefined for the other providers. */
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

/**
 * A subscription, or a thrown sentence saying what is wrong with it. The
 * sentence never repeats the credential.
 */
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

/** The token a credential reference names, or undefined when it cannot be read here. */
export type CredentialResolver = (
	reference: string,
) => Promise<string | undefined>;

/**
 * Resolves `env:NAME` from `env`. A `github-secret:` reference lives in a
 * repository's Actions secrets, which a relay cannot read, so it resolves to
 * nothing and that provider stays on the ledger.
 */
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
