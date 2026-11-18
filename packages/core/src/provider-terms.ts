export type ProviderTerms = {
	readonly reviewedOn: string;
	readonly url: string;
};

export const PROVIDER_TERMS_REGISTRY = Object.freeze({
	"@hobo/provider-aws": {
		url: "https://aws.amazon.com/service-terms/",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-azure": {
		url: "https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/all",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-browser-wasm": {
		url: "https://github.com/Hobo-Labs/HoBo/blob/main/LICENSE",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-cloudflare": {
		url: "https://www.cloudflare.com/terms/",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-convex": {
		url: "https://www.convex.dev/legal/terms",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-digitalocean": {
		url: "https://www.digitalocean.com/legal/terms-of-service-agreement",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-gcp": {
		url: "https://cloud.google.com/terms",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-hetzner": {
		url: "https://www.hetzner.com/legal/terms-and-conditions/",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-hostinger": {
		url: "https://www.hostinger.com/legal/universal-terms-of-service-agreement",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-kafka": {
		url: "https://www.apache.org/licenses/LICENSE-2.0",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-kubernetes": {
		url: "https://www.apache.org/licenses/LICENSE-2.0",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-lakebed": {
		url: "https://lakebed.app/terms",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-netlify": {
		url: "https://www.netlify.com/legal/terms-of-use/",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-railway": {
		url: "https://railway.com/legal/terms",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-vercel": {
		url: "https://vercel.com/legal/terms",
		reviewedOn: "2026-11-18",
	},
	"@hobo/provider-webernetes": {
		url: "https://github.com/Hobo-Labs/HoBo/blob/main/LICENSE",
		reviewedOn: "2026-11-18",
	},
	"@hobo/runner-blacksmith": {
		url: "https://docs.blacksmith.sh/about/terms-of-service",
		reviewedOn: "2026-11-18",
	},
	"@hobo/runner-depot": {
		url: "https://depot.dev/terms-of-service",
		reviewedOn: "2026-11-18",
	},
	"@hobo/runner-github": {
		url: "https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features",
		reviewedOn: "2026-11-18",
	},
} satisfies Readonly<Record<string, ProviderTerms>>);

export type ProviderTermsId = keyof typeof PROVIDER_TERMS_REGISTRY;

export function providerTermsFor(providerId: ProviderTermsId): ProviderTerms {
	return PROVIDER_TERMS_REGISTRY[providerId];
}
