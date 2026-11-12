import { createHash } from "node:crypto";
import {
	type ClaimableOperationKeyDeriver,
	createBoundedFetchTransport,
	createClaimableOperationKeyDeriver,
	createResolverRegistry,
	type HttpTransport,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import {
	AWS_LAMBDA_PRODUCT_ID,
	type AwsResolverOptions,
	awsResolverRegistry,
} from "@hobo/provider-aws";
import {
	AZURE_CONTAINER_APPS_PRODUCT_ID,
	type AzureResolverOptions,
	azureResolverRegistry,
} from "@hobo/provider-azure";
import {
	type CloudflareResolverOptions,
	cloudflareResolverRegistry,
} from "@hobo/provider-cloudflare";
import {
	DIGITALOCEAN_APP_JOB_PRODUCT_ID,
	DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
	DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID,
	DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	type DigitalOceanResolverOptions,
	digitaloceanResolverRegistry,
} from "@hobo/provider-digitalocean";
import {
	GCP_CLOUD_RUN_JOB_PRODUCT_ID,
	GCP_CLOUD_RUN_PRODUCT_ID,
	type GcpResolverOptions,
	gcpResolverRegistry,
} from "@hobo/provider-gcp";
import {
	GITHUB_PAGES_SITE_PRODUCT_ID,
	type GithubPagesResolverOptions,
	githubResolverRegistry,
	parseGithubApiBinding,
} from "@hobo/provider-github";
import {
	HETZNER_CLOUD_SERVER_PRODUCT_ID,
	type HetznerResolverOptions,
	hetznerResolverRegistry,
} from "@hobo/provider-hetzner";
import {
	type HostingerResolverOptions,
	hostingerResolverRegistry,
} from "@hobo/provider-hostinger";
import {
	type KubernetesResolverOptions,
	kubernetesResolverRegistry,
} from "@hobo/provider-kubernetes";
import {
	type LakebedResolverOptions,
	lakebedResolverRegistry,
} from "@hobo/provider-lakebed";
import { createNeonClaimableResolver } from "@hobo/provider-neon";
import {
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
	type NetlifyResolverOptions,
	netlifyResolverRegistry,
} from "@hobo/provider-netlify";
import {
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	type NpmResolverOptions,
	npmResolverRegistry,
	parseNpmRegistryBinding,
} from "@hobo/provider-npm";
import {
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	type OciRegistryCredential,
	type OciRegistryResolverOptions,
	ociRegistryResolverRegistry,
} from "@hobo/provider-oci-registry";
import { createPrismaClaimableResolver } from "@hobo/provider-prisma-postgres";
import {
	type RailwayResolverOptions,
	railwayResolverRegistry,
} from "@hobo/provider-railway";
import { createUpstashTemporaryRedisResolver } from "@hobo/provider-upstash";
import {
	VERCEL_EDGE_CONFIG_PRODUCT_ID,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
	type VercelResolverOptions,
	vercelResolverRegistry,
} from "@hobo/provider-vercel";
import type { createVerifiedHostingCredentialLease } from "./hosting-credential-scope.js";
import { isJsonString, type JsonObject } from "./json.js";
import type {
	HostingDesiredInput,
	HostingOperatingLiabilityReader,
	HostingResourceLifecycleReader,
	ProductionResolverBinding,
} from "./resolver-hosting-provider.js";

type Lease<T> = Awaited<
	ReturnType<typeof createVerifiedHostingCredentialLease<T>>
>;
type StringLease = Lease<string>;
type Common<T> = {
	readonly lease: Lease<T>;
	readonly transport?: HttpTransport;
	readonly observeOperatingLiability: HostingOperatingLiabilityReader;
	readonly observeLifecycle?: HostingResourceLifecycleReader;
};
type TokenEntry<P extends string, O> = Common<string> & {
	readonly providerId: P;
	readonly options: O;
};
type Auxiliary<T> = T extends (...args: never[]) => Promise<infer V>
	? Lease<V>
	: never;
type ScopeLease = Pick<
	StringLease,
	"binding" | "credentialRef" | "verifyCredentialScope"
>;

/** Each constructor is the shipped native driver, with version-pinned material
 * supplied by a verified lease. There is no ambient credential lookup here. */
export type HostingProviderCatalogEntry =
	| (Common<Awaited<ReturnType<AwsResolverOptions["resolveCredential"]>>> & {
			readonly providerId: "aws";
			readonly options: Omit<AwsResolverOptions, "resolveCredential">;
	  })
	| TokenEntry<"azure", Omit<AzureResolverOptions, "resolveCredential">>
	| TokenEntry<"gcp", Omit<GcpResolverOptions, "resolveCredential">>
	| TokenEntry<
			"cloudflare",
			Omit<CloudflareResolverOptions, "resolveCredential">
	  >
	| (TokenEntry<
			"digitalocean",
			Omit<
				DigitalOceanResolverOptions,
				"resolveCredential" | "resolveSpacesCredential"
			>
	  > & {
			readonly spacesLease?: Auxiliary<
				NonNullable<DigitalOceanResolverOptions["resolveSpacesCredential"]>
			>;
	  })
	| (TokenEntry<
			"hetzner",
			Omit<
				HetznerResolverOptions,
				| "resolveCredential"
				| "resolveObjectStorageCredential"
				| "resolveStorageBoxPassword"
			>
	  > & {
			readonly objectStorageLease?: Auxiliary<
				NonNullable<HetznerResolverOptions["resolveObjectStorageCredential"]>
			>;
			readonly storageBoxPasswordLeases?: ReadonlyMap<string, StringLease>;
	  })
	| (TokenEntry<
			"hostinger",
			Omit<
				HostingerResolverOptions,
				"resolveCredential" | "resolveDatabasePassword"
			>
	  > & { readonly databasePasswordLeases?: ReadonlyMap<string, StringLease> })
	| (TokenEntry<
			"kubernetes",
			Omit<KubernetesResolverOptions, "resolveCredential" | "resolveSecretData">
	  > & {
			readonly secretDataLeases?: ReadonlyMap<
				string,
				Lease<Readonly<Record<string, string>>>
			>;
	  })
	| TokenEntry<"netlify", Omit<NetlifyResolverOptions, "resolveCredential">>
	| TokenEntry<"vercel", Omit<VercelResolverOptions, "resolveCredential">>
	| TokenEntry<"railway", Omit<RailwayResolverOptions, "resolveCredential">>
	| TokenEntry<"npm", Omit<NpmResolverOptions, "resolveCredential">>
	| (Common<OciRegistryCredential> & {
			readonly providerId: "oci-registry";
			/** Source registries pull anonymously or by same-host mount here. */
			readonly options: Omit<OciRegistryResolverOptions, "resolveCredential">;
	  })
	| (TokenEntry<
			"github",
			Omit<
				GithubPagesResolverOptions,
				"resolveCredential" | "resolveDeploymentOidcToken"
			>
	  > & {
			/** Pages-deployment mode only: the workflow OIDC token, same account. */
			readonly deploymentOidcLease?: StringLease;
	  })
	| TokenEntry<
			"neon",
			Omit<
				Parameters<typeof createNeonClaimableResolver>[0],
				"deriveOperationKey"
			>
	  >
	| TokenEntry<
			"prisma",
			Omit<
				Parameters<typeof createPrismaClaimableResolver>[0],
				"deriveOperationKey"
			>
	  >
	| TokenEntry<
			"upstash",
			Omit<
				Parameters<typeof createUpstashTemporaryRedisResolver>[0],
				"deriveOperationKey"
			>
	  >
	| TokenEntry<"lakebed", Omit<LakebedResolverOptions, "resolveCredential">>
	| ExternalRegistryEntry
	| ComponentProviderEntry;

/** Registry shape every provider package exports as `<name>ResolverRegistry`. */
export interface HostingResolverRegistry {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
}

/**
 * Hosting providers `@hobo/hobo` does not depend on (plan 0024 WP13 packages
 * and browser-wasm). The composition root, which does depend on them, binds
 * each package's exported `<name>ResolverRegistry` here; the catalog still
 * pins the verified credential and refuses any resolver outside the provider's
 * declared delivery coverage.
 */
export type ExternalHostingProviderId =
	| "convex"
	| "flux"
	| "webernetes"
	| "browser-wasm";

export type ExternalRegistryEntry = Common<string> & {
	readonly providerId: ExternalHostingProviderId;
	/** Called once with the lease-pinned credential lookup. */
	readonly createRegistry: (
		resolveCredential: (credentialRef: string) => Promise<string>,
	) => HostingResolverRegistry;
};

/**
 * An out-of-tree platform realized only by `hobo:resolver` WASM components
 * (D6). Its resolvers arrive through `extraResolvers`; this entry supplies the
 * verified credential scope they are executed under.
 */
export type ComponentProviderEntry = Common<string> & {
	readonly providerId: "component";
	/** The components' `providerId`; never a native catalog id. */
	readonly componentProviderId: string;
};

export interface ProductionHostingCatalogOptions {
	/**
	 * Component resolvers (`@hobo/resolver-components` output, bound by the
	 * composition root). Each joins the entry whose native id equals its
	 * `providerId`, or the `component` entry naming that id. A product a
	 * shipped resolver already owns is refused, never shadowed.
	 */
	readonly extraResolvers?: readonly ResourceResolver[];
}

// Exact manifest/native mappings; no package-name trimming at the trust boundary.
const MANIFEST_IDS = Object.freeze({
	aws: "@hobo/provider-aws",
	azure: "@hobo/provider-azure",
	gcp: "@hobo/provider-gcp",
	cloudflare: "@hobo/provider-cloudflare",
	digitalocean: "@hobo/provider-digitalocean",
	hetzner: "@hobo/provider-hetzner",
	hostinger: "@hobo/provider-hostinger",
	kubernetes: "@hobo/provider-kubernetes",
	netlify: "@hobo/provider-netlify",
	vercel: "@hobo/provider-vercel",
	railway: "@hobo/provider-railway",
	npm: "@hobo/provider-npm",
	"oci-registry": "@hobo/provider-oci-registry",
	github: "@hobo/provider-github",
	neon: "@hobo/provider-neon",
	prisma: "@hobo/provider-prisma-postgres",
	upstash: "@hobo/provider-upstash",
	lakebed: "@hobo/provider-lakebed",
	convex: "@hobo/provider-convex",
	flux: "@hobo/provider-flux",
	webernetes: "@hobo/provider-webernetes",
	"browser-wasm": "@hobo/provider-browser-wasm",
});

const COMPONENT_PROVIDER_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/u;

/** How a provider realizes traffic: an exported profile, or a typed refusal. */
export type ProviderTrafficCoverage =
	| { readonly kind: "profile"; readonly profileExport: string }
	| {
			readonly kind: "refused";
			readonly reason: string;
			readonly remediation: string;
	  };

/**
 * One row of the I14 delivery table: every package under `packages/providers`
 * resolves to a realization path plus a traffic profile, or is refused with a
 * typed reason. Provider-level detail (which products, which offerings are
 * absent) lives in each package's `<NAME>_HOSTING_COVERAGE`.
 */
// domain-view: catalog-level I14 row; per-provider wire form is HostingCoverage in packages/providers/provider-*/data-models/hosting_coverage.proto (CUE #HostingCoverage).
export type ProviderDeliveryCoverage =
	| {
			readonly packageName: string;
			readonly providerId: string;
			readonly realization: "resolver";
			/** Exported resolver registry or resolver factory. */
			readonly resolverExport: string;
			/** Exported `<NAME>_HOSTING_COVERAGE`, where the package publishes one. */
			readonly coverageExport?: string;
			/** Declared products, for packages the catalog binds without importing. */
			readonly resolvedProductIds?: readonly string[];
			readonly traffic: ProviderTrafficCoverage;
	  }
	| {
			readonly packageName: string;
			readonly providerId: string;
			readonly realization: "refused";
			readonly reason: string;
			readonly remediation: string;
	  };

function hosting(
	providerId: string,
	packageName: string,
	stem: string,
	extra: {
		readonly coverage?: boolean;
		readonly products?: string[];
		/** Traffic-profile stem when it differs from the registry stem. */
		readonly profileStem?: string;
	} = {},
): ProviderDeliveryCoverage {
	const constant = (value: string) =>
		value.replace(/[A-Z]/gu, (c) => `_${c}`).toUpperCase();
	const upper = constant(stem);
	const base = {
		packageName,
		providerId,
		realization: "resolver" as const,
		resolverExport: `${stem}ResolverRegistry`,
		traffic: Object.freeze({
			kind: "profile" as const,
			profileExport: `${constant(extra.profileStem ?? stem)}_TRAFFIC_ROUTING_PROFILE`,
		}),
	};
	const covered = extra.coverage
		? { ...base, coverageExport: `${upper}_HOSTING_COVERAGE` }
		: base;
	const row = extra.products
		? {
				...covered,
				resolvedProductIds: Object.freeze([...extra.products].sort()),
			}
		: covered;
	return Object.freeze(row);
}

const DATA_TRAFFIC = Object.freeze({
	kind: "refused" as const,
	reason:
		"A data store carries no request traffic HoBo routes; traffic offerings do not apply.",
	remediation:
		"Shift traffic on the workload that uses the store; move data with a Trails handover, never by routing.",
});

function data(
	providerId: string,
	packageName: string,
	resolverExport: string,
): ProviderDeliveryCoverage {
	return Object.freeze({
		packageName,
		providerId,
		realization: "resolver" as const,
		resolverExport,
		traffic: DATA_TRAFFIC,
	});
}

function refused(
	providerId: string,
	packageName: string,
	reason: string,
	remediation: string,
): ProviderDeliveryCoverage {
	return Object.freeze({
		packageName,
		providerId,
		realization: "refused" as const,
		reason,
		remediation,
	});
}

const NOT_A_TARGET =
	"bind a hosting provider for delivery; this package is wired by its own port";

/** The I14 table (plan 0024 WP14): one row per `packages/providers/*` package. */
export const PROVIDER_DELIVERY_COVERAGE: readonly ProviderDeliveryCoverage[] =
	Object.freeze([
		hosting("aws", "@hobo/provider-aws", "aws"),
		hosting("azure", "@hobo/provider-azure", "azure"),
		hosting("browser-wasm", "@hobo/provider-browser-wasm", "browserWasm", {
			coverage: true,
			products: ["browser-wasm.guest/v1"],
		}),
		hosting("cloudflare", "@hobo/provider-cloudflare", "cloudflare"),
		hosting("convex", "@hobo/provider-convex", "convex", {
			coverage: true,
			products: ["convex.cloud-deployment/v1"],
		}),
		hosting("digitalocean", "@hobo/provider-digitalocean", "digitalocean"),
		hosting("flux", "@hobo/provider-flux", "flux", {
			coverage: true,
			products: ["flux.app/v1"],
		}),
		hosting("gcp", "@hobo/provider-gcp", "gcp"),
		hosting("github", "@hobo/provider-github", "github", {
			profileStem: "githubPages",
			products: [GITHUB_PAGES_SITE_PRODUCT_ID],
		}),
		hosting("hetzner", "@hobo/provider-hetzner", "hetzner"),
		hosting("hostinger", "@hobo/provider-hostinger", "hostinger"),
		hosting("kubernetes", "@hobo/provider-kubernetes", "kubernetes"),
		hosting("lakebed", "@hobo/provider-lakebed", "lakebed", {
			coverage: true,
		}),
		hosting("netlify", "@hobo/provider-netlify", "netlify", {
			coverage: true,
		}),
		hosting("npm", "@hobo/provider-npm", "npm", {
			products: [NPM_PACKAGE_VERSION_PRODUCT_ID],
		}),
		hosting("oci-registry", "@hobo/provider-oci-registry", "ociRegistry", {
			coverage: true,
			products: [OCI_REGISTRY_IMAGE_PRODUCT_ID],
		}),
		hosting("railway", "@hobo/provider-railway", "railway", {
			coverage: true,
		}),
		hosting("vercel", "@hobo/provider-vercel", "vercel", { coverage: true }),
		hosting("webernetes", "@hobo/provider-webernetes", "webernetes", {
			coverage: true,
			products: ["webernetes.pod/v1"],
		}),
		data("neon", "@hobo/provider-neon", "createNeonClaimableResolver"),
		data(
			"prisma",
			"@hobo/provider-prisma-postgres",
			"createPrismaClaimableResolver",
		),
		data(
			"upstash",
			"@hobo/provider-upstash",
			"createUpstashTemporaryRedisResolver",
		),
		refused(
			"agentv",
			"@hobo/provider-agentv",
			"agentV grades recorded agent trajectories; it is an evaluation engine, not a delivery target.",
			NOT_A_TARGET,
		),
		refused(
			"ax",
			"@hobo/provider-ax",
			"ax is the built-in hobo:training-engine; it optimizes programs and hosts nothing.",
			NOT_A_TARGET,
		),
		refused(
			"cedar",
			"@hobo/provider-cedar",
			"Cedar is a policy engine behind the gate plane; it decides, it does not host.",
			NOT_A_TARGET,
		),
		refused(
			"config",
			"@hobo/provider-config",
			"wasi:config/store is linked into a component at instantiation; there is no delivered resource.",
			"declare config on the workload; the component host links the store",
		),
		refused(
			"kafka",
			"@hobo/provider-kafka",
			"Kafka is a messaging capability realized through the resource graph (realizeKafkaResources, attested apply by ResourceActors, D6), not a hosting product with a resolver.",
			"declare topics in the Bindle; they are applied as resource-graph changes, or bind a hosted queue such as @hobo/provider-upstash",
		),
		refused(
			"opa",
			"@hobo/provider-opa",
			"OPA is a policy engine behind the gate plane; it decides, it does not host.",
			NOT_A_TARGET,
		),
		refused(
			"ttl-sh",
			"@hobo/provider-ttl-sh",
			"ttl.sh is an anonymous, expiring artifact transport for the anonymous deploy path; it never hosts or owns a resource.",
			"use it only to hand a pull reference to a host; promotion pins digests in a durable registry (@hobo/cd artifact store)",
		),
		refused(
			"turso",
			"@hobo/provider-turso",
			"The libSQL EphemeralStatePort binding backs the hosted relay's cache; it is not a delivery target.",
			"bind a database provider with a resolver (neon, prisma) for delivered data",
		),
		refused(
			"vercel-blob",
			"@hobo/provider-vercel-blob",
			"The Vercel Blob EphemeralStatePort binding backs the hosted relay's cache; it is not a delivery target.",
			"bind an objectStore provider with a resolver for delivered storage",
		),
		refused(
			"blacksmith",
			"@hobo/runner-blacksmith",
			"A CI runner executes builds; CD never delivers to it (any CI may feed Freight).",
			"deliver to a hosting provider; runners are selected by @hobo/ci",
		),
		refused(
			"depot",
			"@hobo/runner-depot",
			"A CI runner executes builds; CD never delivers to it (any CI may feed Freight).",
			"deliver to a hosting provider; runners are selected by @hobo/ci",
		),
		refused(
			"github-runner",
			"@hobo/runner-github",
			"A CI runner executes builds; CD never delivers to it (any CI may feed Freight).",
			"deliver to a hosting provider; runners are selected by @hobo/ci",
		),
	]);

/**
 * The typed refusal for delivering to a provider package that has no
 * realization path (I14), or `undefined` when it has one. Unknown names are
 * refused too, naming the out-of-tree escape (D6).
 */
export function providerDeliveryRefusal(
	providerIdOrPackage: string,
): ResolverError | undefined {
	const row = PROVIDER_DELIVERY_COVERAGE.find(
		(entry) =>
			entry.providerId === providerIdOrPackage ||
			entry.packageName === providerIdOrPackage,
	);
	if (row?.realization === "resolver") return undefined;
	if (row)
		return new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${row.packageName}: ${row.reason} Remediation: ${row.remediation}`,
		);
	return new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`${JSON.stringify(providerIdOrPackage)} is not a catalogued provider. Remediation: register a signed hobo:resolver WASM component for it (D6) and add a component catalog entry`,
	);
}

function pinnedCredential<T>(lease: Lease<T>) {
	return async (ref: string) => {
		if (ref !== lease.credentialRef)
			throw new Error("provider IO requested an unverified credential version");
		return lease.resolveCredential();
	};
}

async function missingAuxiliaryCredential(): Promise<never> {
	throw new Error(
		"provider product requires independently enrolled credential material",
	);
}

function auxiliaryCredential<T>(primaryRef: string, lease: Lease<T>) {
	return async (ref: string) => {
		if (ref !== primaryRef)
			throw new Error(
				"provider IO requested an unverified primary credential version",
			);
		return lease.resolveCredential();
	};
}

function logicalCredential<T>(leases: ReadonlyMap<string, Lease<T>>) {
	return async (logicalId: string) => {
		const lease = leases.get(logicalId);
		if (!lease)
			throw new Error("provider resource has no enrolled credential material");
		return lease.resolveCredential();
	};
}

function claimableOptions(
	options: Pick<
		Parameters<typeof createNeonClaimableResolver>[0],
		"scope" | "repository" | "journal"
	>,
) {
	const repository = options.repository;
	const journal = options.journal;
	return {
		scope: Object.freeze({ ...options.scope }),
		repository: Object.freeze({
			persistence: repository.persistence,
			read: repository.read.bind(repository),
			write: repository.write.bind(repository),
			readObservation: repository.readObservation.bind(repository),
			writeObservation: repository.writeObservation.bind(repository),
		}),
		journal: Object.freeze({
			persistence: journal.persistence,
			claim: journal.claim.bind(journal),
			acknowledge: journal.acknowledge.bind(journal),
			uncertain: journal.uncertain.bind(journal),
		}),
	};
}

function privateClaimableKey(lease: StringLease): ClaimableOperationKeyDeriver {
	let captured: Promise<ClaimableOperationKeyDeriver> | undefined;
	return async (scope, request) => {
		if (
			scope.tenantId !== lease.binding.tenantId ||
			scope.providerAccountId !== lease.binding.providerAccountId
		)
			throw new Error(
				"private claimable key belongs to another tenant or account",
			);
		captured ??= lease.resolveCredential().then((material) => {
			if (!/^[A-Za-z0-9_-]{43,171}$/u.test(material))
				throw new Error(
					"claimable hosting requires a private canonical base64url key of at least 256 bits",
				);
			const key = Buffer.from(material, "base64url");
			if (
				key.length < 32 ||
				key.length > 128 ||
				key.toString("base64url") !== material
			)
				throw new Error(
					"claimable hosting requires a private canonical base64url key of at least 256 bits",
				);
			const derive = createClaimableOperationKeyDeriver(new Uint8Array(key));
			key.fill(0);
			return derive;
		});
		return (await captured)(scope, request);
	};
}

/** The id a binding is keyed and scoped by: the native id, or the component's. */
function catalogNativeId(entry: HostingProviderCatalogEntry): string {
	if (entry.providerId !== "component") return entry.providerId;
	const id = entry.componentProviderId;
	if (
		!COMPONENT_PROVIDER_ID.test(id) ||
		id === "component" ||
		Object.hasOwn(MANIFEST_IDS, id)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`component provider id ${JSON.stringify(id)} is malformed or shadows a native catalog provider. Remediation: give the component bundle its own provider id`,
		);
	return id;
}

function verifyNativeScope(entry: HostingProviderCatalogEntry) {
	const native = entry.lease.binding.nativeAccountRef;
	if (["neon", "prisma", "upstash"].includes(entry.providerId)) {
		switch (entry.providerId) {
			case "neon":
			case "prisma":
			case "upstash":
				if (
					entry.options.scope.tenantId !== entry.lease.binding.tenantId ||
					entry.options.scope.providerAccountId !==
						entry.lease.binding.providerAccountId
				)
					throw new Error(
						"claimable resolver scope differs from the verified tenant and account",
					);
		}
	}
	let expected: string;
	switch (entry.providerId) {
		case "aws":
			expected = `aws://accounts/${entry.lease.binding.providerAccountId}`;
			break;
		case "azure":
			expected = `azure://subscriptions/${entry.options.subscriptionId}/resourceGroups/${entry.options.resourceGroup}`;
			break;
		case "gcp":
			expected = `gcp://projects/${entry.options.projectId}`;
			break;
		case "cloudflare":
			expected = `cloudflare://accounts/${entry.options.accountId}`;
			break;
		case "netlify":
			expected = `netlify://accounts/${entry.options.accountId}`;
			break;
		case "railway":
			expected = `railway://projects/${entry.options.projectId}/environments/${entry.options.environmentId}`;
			break;
		case "npm":
			expected = `npm://registries/${encodeURIComponent(parseNpmRegistryBinding(entry.options.registry).base)}`;
			break;
		case "oci-registry":
			expected = `oci-registry://registries/${encodeURIComponent(entry.options.registry.host)}`;
			break;
		case "github":
			expected = `github://apis/${encodeURIComponent(parseGithubApiBinding(entry.options.api).base)}/accounts/${entry.lease.binding.providerAccountId}`;
			break;
		case "vercel":
			if (!entry.options.teamId)
				throw new Error(
					"production Vercel catalog requires an explicit team scope",
				);
			expected = `vercel://teams/${entry.options.teamId}`;
			break;
		case "kubernetes":
			expected = `kubernetes://clusters/${encodeURIComponent(new URL(entry.options.apiServerUrl).origin)}`;
			break;
		default:
			expected = `${catalogNativeId(entry)}://accounts/${entry.lease.binding.providerAccountId}`;
	}
	if (
		entry.lease.binding.providerId !== catalogNativeId(entry) ||
		native !== expected
	)
		throw new Error(
			"provider catalog native scope differs from verified credential scope",
		);
}

const OWNED_HOSTING_PRODUCTS = new Set([
	AWS_LAMBDA_PRODUCT_ID,
	AZURE_CONTAINER_APPS_PRODUCT_ID,
	GCP_CLOUD_RUN_PRODUCT_ID,
	GCP_CLOUD_RUN_JOB_PRODUCT_ID,
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
	DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID,
	DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
	DIGITALOCEAN_APP_JOB_PRODUCT_ID,
	HETZNER_CLOUD_SERVER_PRODUCT_ID,
]);

/** Compile only metadata implemented by the selected native product. The graph
 * marker records ownership and cannot substitute for observed content identity. */
export function prepareHostingProviderDesired(
	providerId: HostingProviderCatalogEntry["providerId"],
	input: HostingDesiredInput,
): JsonObject {
	if (
		!input.logicalId ||
		!input.ownershipRef ||
		!input.operationId ||
		!/^sha256:[a-f0-9]{64}$/u.test(input.artifactId)
	)
		throw new Error(
			"hosting desired compilation requires complete immutable identity",
		);
	if (input.source && !input.physicalId)
		throw new Error(
			"existing hosting resource requires a pinned physical identity",
		);
	const result = { ...structuredClone(input.parameters) };
	if (input.source) return result;
	function metadata(field: string, value: string) {
		if (result[field] !== undefined && result[field] !== value)
			throw new Error(
				`desired.${field} conflicts with approved hosting metadata`,
			);
		result[field] = value;
	}
	if (
		providerId === "neon" ||
		providerId === "prisma" ||
		providerId === "upstash"
	)
		return result;
	// Provider-owned desired grammars (WP13 packages, components): the catalog
	// adds nothing the resolver would have to refuse as undeclared.
	if (
		providerId === "convex" ||
		providerId === "flux" ||
		providerId === "webernetes" ||
		providerId === "component"
	)
		return result;
	// Promote, never rebuild (I1): these resolvers pin the observed content.
	if (
		providerId === "lakebed" ||
		providerId === "browser-wasm" ||
		providerId === "npm" ||
		providerId === "oci-registry" ||
		providerId === "github"
	) {
		if (
			input.contentDigest === undefined ||
			!/^sha256:[a-f0-9]{64}$/u.test(input.contentDigest)
		)
			throw new Error(
				`${providerId} hosting requires the approved content digest of the delivered artifact`,
			);
		// An OCI image is identified by its manifest digest; the others by
		// the Freight blob digest (tarball, static-site tree index, capsule).
		metadata(
			providerId === "oci-registry" ? "digest" : "artifactDigest",
			input.contentDigest,
		);
		return result;
	}
	if (providerId === "railway") {
		if (!isJsonString(result.serviceId) || !result.serviceId)
			throw new Error(
				"Railway requires an explicitly approved existing service",
			);
		metadata("operationId", input.operationId);
		return result;
	}
	const immutableDeployment =
		(providerId === "netlify" &&
			input.productId === NETLIFY_STATIC_DEPLOY_PRODUCT_ID) ||
		(providerId === "vercel" &&
			input.productId === VERCEL_STATIC_DEPLOY_PRODUCT_ID);
	if (!input.source && !immutableDeployment) {
		if (
			providerId === "vercel" &&
			input.productId === VERCEL_EDGE_CONFIG_PRODUCT_ID
		)
			result.slug = input.logicalId;
		else result.name = input.logicalId;
		if (providerId === "azure")
			for (const alias of ["vaultName", "cacheName", "tableName"])
				if (result[alias] !== undefined) result[alias] = input.logicalId;
	}
	if (OWNED_HOSTING_PRODUCTS.has(input.productId)) {
		if (input.contentDigest !== undefined) {
			if (!/^sha256:[a-f0-9]{64}$/u.test(input.contentDigest))
				throw new Error("hosting content identity is malformed");
			const image = result.image;
			if (
				isJsonString(image) &&
				/@sha256:/u.test(image) &&
				!image.endsWith(`@${input.contentDigest}`)
			)
				throw new Error(
					"native image differs from the approved resource content digest",
				);
		}
		metadata(
			"ownershipRef",
			`sha256:${createHash("sha256")
				.update(
					JSON.stringify([
						"hobo.hosting-ownership/v1",
						providerId,
						input.productId,
						input.ownershipRef,
					]),
				)
				.digest("hex")}`,
		);
		metadata("artifactDigest", input.artifactId);
	}
	if (providerId === "netlify" || providerId === "vercel")
		metadata("operationId", input.operationId);
	return result;
}

/** Build both explicit plan aliases around the same immutable binding. Registry
 * discovery does not itself admit a financial effect; liability proof remains
 * mandatory at execution. Unsupported products have no executable resolver. */
export function createProductionHostingProviderCatalog(
	entries: readonly HostingProviderCatalogEntry[],
	options: ProductionHostingCatalogOptions = {},
): ReadonlyMap<string, ProductionResolverBinding> {
	const result = new Map<string, ProductionResolverBinding>();
	const pendingExtras = groupExtraResolvers(options.extraResolvers ?? []);
	for (const entry of entries) {
		verifyNativeScope(entry);
		const nativeId = catalogNativeId(entry);
		if (result.has(nativeId))
			throw new Error("duplicate production provider scope");
		const lease = entry.lease;
		const manifestId =
			entry.providerId === "component"
				? nativeId
				: MANIFEST_IDS[entry.providerId];
		if (
			!(entry.observeOperatingLiability instanceof Function) ||
			(entry.observeLifecycle !== undefined &&
				!(entry.observeLifecycle instanceof Function))
		)
			throw new Error(
				"production catalog requires authenticated financial readers",
			);
		const extras: ScopeLease[] = [];
		let registry: HostingResolverRegistry;
		switch (entry.providerId) {
			case "lakebed":
				registry = lakebedResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			case "convex":
			case "flux":
			case "webernetes":
			case "browser-wasm":
				registry = externalRegistry(
					entry.providerId,
					entry.createRegistry,
					pinnedCredential(entry.lease),
				);
				break;
			case "component":
				registry = createResolverRegistry([]);
				break;
			case "aws":
				registry = awsResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			case "azure":
				registry = azureResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			case "gcp": {
				const nativeOptions = {
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				};
				if (entry.options.operationPoll)
					nativeOptions.operationPoll = Object.freeze({
						...entry.options.operationPoll,
					});
				registry = gcpResolverRegistry(nativeOptions);
				break;
			}
			case "cloudflare":
				registry = cloudflareResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			case "digitalocean":
				registry = digitaloceanResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
					resolveSpacesCredential: entry.spacesLease
						? auxiliaryCredential(entry.lease.credentialRef, entry.spacesLease)
						: missingAuxiliaryCredential,
				});
				break;
			case "hetzner": {
				const boxPasswords = new Map(entry.storageBoxPasswordLeases);
				extras.push(...boxPasswords.values());
				registry = hetznerResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
					resolveObjectStorageCredential: entry.objectStorageLease
						? auxiliaryCredential(
								entry.lease.credentialRef,
								entry.objectStorageLease,
							)
						: missingAuxiliaryCredential,
					resolveStorageBoxPassword: logicalCredential(boxPasswords),
				});
				break;
			}
			case "hostinger": {
				const databasePasswords = new Map(entry.databasePasswordLeases);
				extras.push(...databasePasswords.values());
				registry = hostingerResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
					resolveDatabasePassword: logicalCredential(databasePasswords),
				});
				break;
			}
			case "kubernetes": {
				const secrets = new Map(entry.secretDataLeases);
				extras.push(...secrets.values());
				registry = kubernetesResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
					resolveSecretData: logicalCredential(secrets),
				});
				break;
			}
			case "netlify":
				registry = netlifyResolverRegistry({
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			case "vercel": {
				const nativeOptions = {
					...entry.options,
					resolveCredential: pinnedCredential(entry.lease),
				};
				if (entry.options.call)
					nativeOptions.call = Object.freeze({ ...entry.options.call });
				registry = vercelResolverRegistry(nativeOptions);
				break;
			}
			case "railway": {
				const deploymentStore = entry.options.deploymentStore;
				if (
					entry.options.mutationJournal?.persistence !== "durable-cas" ||
					!deploymentStore ||
					deploymentStore.tenantId !== entry.lease.binding.tenantId
				)
					throw new Error(
						"production Railway requires a tenant-scoped durable deployment store and mutation journal",
					);
				registry = railwayResolverRegistry({
					...entry.options,
					deploymentStore: Object.freeze({
						...deploymentStore,
						actor: Object.freeze({ ...deploymentStore.actor }),
					}),
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			}
			case "npm":
				registry = npmResolverRegistry({
					...entry.options,
					registry: Object.freeze({ ...entry.options.registry }),
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			case "oci-registry": {
				const sources = entry.options.sourceRegistries ?? [];
				if (sources.some((source) => source.credentialRef !== undefined))
					throw new Error(
						"production OCI catalog pulls source registries anonymously or by same-host mount; a source pull credential needs its own enrolled catalog entry",
					);
				registry = ociRegistryResolverRegistry({
					...entry.options,
					registry: Object.freeze({ ...entry.options.registry }),
					sourceRegistries: Object.freeze(
						sources.map((source) => Object.freeze({ ...source })),
					),
					resolveCredential: pinnedCredential(entry.lease),
				});
				break;
			}
			case "github":
				registry = githubResolverRegistry({
					...entry.options,
					api: Object.freeze({ ...entry.options.api }),
					resolveCredential: pinnedCredential(entry.lease),
					...(entry.deploymentOidcLease
						? {
								resolveDeploymentOidcToken: auxiliaryCredential(
									entry.lease.credentialRef,
									entry.deploymentOidcLease,
								),
							}
						: {}),
				});
				break;
			case "neon":
				registry = createResolverRegistry([
					createNeonClaimableResolver({
						...entry.options,
						...claimableOptions(entry.options),
						deriveOperationKey: privateClaimableKey(entry.lease),
						secretResolver: Object.freeze({
							resolve: entry.options.secretResolver.resolve.bind(
								entry.options.secretResolver,
							),
						}),
						custody: Object.freeze({
							deposit: entry.options.custody.deposit.bind(
								entry.options.custody,
							),
						}),
						driver: Object.freeze({
							...entry.options.driver,
							provision: entry.options.driver.provision.bind(
								entry.options.driver,
							),
							observe: entry.options.driver.observe.bind(entry.options.driver),
						}),
					}),
				]);
				break;
			case "prisma":
				registry = createResolverRegistry([
					createPrismaClaimableResolver({
						...entry.options,
						...claimableOptions(entry.options),
						deriveOperationKey: privateClaimableKey(entry.lease),
						secretResolver: Object.freeze({
							resolve: entry.options.secretResolver.resolve.bind(
								entry.options.secretResolver,
							),
						}),
						custody: Object.freeze({
							deposit: entry.options.custody.deposit.bind(
								entry.options.custody,
							),
						}),
						driver: Object.freeze({
							...entry.options.driver,
							provision: entry.options.driver.provision.bind(
								entry.options.driver,
							),
							observe: entry.options.driver.observe.bind(entry.options.driver),
						}),
					}),
				]);
				break;
			case "upstash":
				registry = createResolverRegistry([
					createUpstashTemporaryRedisResolver({
						...entry.options,
						...claimableOptions(entry.options),
						deriveOperationKey: privateClaimableKey(entry.lease),
						secretResolver: Object.freeze({
							resolve: entry.options.secretResolver.resolve.bind(
								entry.options.secretResolver,
							),
						}),
						custody: Object.freeze({
							deposit: entry.options.custody.deposit.bind(
								entry.options.custody,
							),
						}),
						driver: Object.freeze({
							...entry.options.driver,
							provision: entry.options.driver.provision.bind(
								entry.options.driver,
							),
							observe: entry.options.driver.observe.bind(entry.options.driver),
						}),
					}),
				]);
				break;
		}
		const shipped = new Set(registry.list().map((item) => item.productId));
		registry = withExtraResolvers(
			nativeId,
			registry,
			pendingExtras,
			entry.providerId === "component",
		);
		// Keep the primary material snapshot captured above. Secondary credentials
		// have independent enrollment proofs and must share the approved account.
		const secondary = [
			...extras,
			...(entry.providerId === "digitalocean" && entry.spacesLease
				? [entry.spacesLease]
				: []),
			...(entry.providerId === "hetzner" && entry.objectStorageLease
				? [entry.objectStorageLease]
				: []),
			...(entry.providerId === "github" && entry.deploymentOidcLease
				? [entry.deploymentOidcLease]
				: []),
		];
		for (const item of secondary)
			if (
				item.binding.tenantId !== lease.binding.tenantId ||
				item.binding.providerId !== lease.binding.providerId ||
				item.binding.providerAccountId !== lease.binding.providerAccountId ||
				item.binding.nativeAccountRef !== lease.binding.nativeAccountRef
			)
				throw new Error(
					"secondary credential belongs to another provider account",
				);
		const operatingReader = entry.observeOperatingLiability;
		const lifecycleReader = entry.observeLifecycle;
		function nativeAlias(providerId: string) {
			if (providerId !== nativeId && providerId !== manifestId)
				throw new Error(
					"financial reader provider is outside the explicit catalog alias mapping",
				);
			return nativeId;
		}
		const composed = {
			prepareDesired(input: HostingDesiredInput) {
				if (!registry.get(input.productId))
					throw new Error(
						"hosting metadata compiler received an unregistered native product",
					);
				// Component products carry their own desired grammar (D6).
				return prepareHostingProviderDesired(
					shipped.has(input.productId) ? entry.providerId : "component",
					input,
				);
			},
			registry,
			transport:
				entry.transport ??
				createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
			credentialRef: lease.credentialRef,
			providerAccountId: lease.binding.providerAccountId,
			async observeOperatingLiability(
				input: Parameters<HostingOperatingLiabilityReader>[0],
			) {
				const normalized = {
					...input,
					node: { ...input.node, provider: nativeAlias(input.node.provider) },
				};
				const observed = await operatingReader(normalized);
				if (
					observed.liability.providerId !== nativeId ||
					observed.liability.providerAccountId !==
						lease.binding.providerAccountId
				)
					throw new Error(
						"native financial evidence belongs to another provider or account",
					);
				return {
					...observed,
					liability: { ...observed.liability, providerId: input.node.provider },
				};
			},
			async verifyCredentialScope(
				input: Parameters<
					ProductionResolverBinding["verifyCredentialScope"]
				>[0],
			) {
				if (input.providerId !== nativeId && input.providerId !== manifestId)
					throw new Error("provider scope is not an explicit catalog alias");
				const normalized = { ...input, providerId: nativeId };
				await lease.verifyCredentialScope(normalized);
				for (const item of secondary)
					await item.verifyCredentialScope({
						...normalized,
						credentialRef: item.credentialRef,
					});
			},
		};
		if (lifecycleReader)
			Object.assign(composed, {
				async observeLifecycle(
					input: Parameters<HostingResourceLifecycleReader>[0],
				) {
					if (
						input.context.providerId !== nativeId ||
						input.context.providerAccountId !== lease.binding.providerAccountId
					)
						throw new Error(
							"lifecycle context is outside the native catalog scope",
						);
					const observed = await lifecycleReader({
						...input,
						node: { ...input.node, provider: nativeAlias(input.node.provider) },
					});
					if (
						observed.providerId !== nativeId ||
						observed.providerAccountId !== lease.binding.providerAccountId
					)
						throw new Error(
							"native lifecycle evidence belongs to another provider or account",
						);
					return observed;
				},
			});
		const binding = Object.freeze(composed);
		result.set(nativeId, binding);
		result.set(manifestId, binding);
	}
	const unmatched = [...pendingExtras.keys()].sort();
	if (unmatched.length > 0)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`component resolvers for ${unmatched.join(", ")} have no verified catalog entry. Remediation: add a { providerId: "component", componentProviderId } entry with an enrolled credential lease for each`,
		);
	return result;
}

/** Group component resolvers by provider id, refusing anything not resolver-shaped. */
function groupExtraResolvers(
	resolvers: readonly ResourceResolver[],
): Map<string, ResourceResolver[]> {
	const grouped = new Map<string, ResourceResolver[]>();
	for (const resolver of resolvers) {
		// Shape check here; core's registry asserts the full resolver contract.
		createResolverRegistry([resolver]);
		const list = grouped.get(resolver.providerId) ?? [];
		list.push(resolver);
		grouped.set(resolver.providerId, list);
	}
	return grouped;
}

/** Join a provider's component resolvers to its shipped registry; never shadow. */
function withExtraResolvers(
	nativeId: string,
	registry: HostingResolverRegistry,
	pending: Map<string, ResourceResolver[]>,
	required: boolean,
): HostingResolverRegistry {
	const extras = pending.get(nativeId) ?? [];
	pending.delete(nativeId);
	if (extras.length === 0) {
		if (required)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`component provider ${nativeId} has a catalog entry but no component resolvers. Remediation: pass its verified components through extraResolvers`,
			);
		return registry;
	}
	for (const extra of extras)
		if (registry.get(extra.productId))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`component resolver for ${extra.productId} would shadow the shipped ${nativeId} resolver. Remediation: give the component its own product id`,
				extra.productId,
			);
	return createResolverRegistry([...registry.list(), ...extras]);
}

/**
 * Bind an external provider package's registry under the pinned credential,
 * refusing resolvers outside its declared delivery coverage (I14).
 */
function externalRegistry(
	providerId: ExternalHostingProviderId,
	create: ExternalRegistryEntry["createRegistry"],
	resolveCredential: (credentialRef: string) => Promise<string>,
): HostingResolverRegistry {
	if (!(create instanceof Function))
		throw new Error(
			`${providerId} catalog entry requires the package's exported resolver registry factory`,
		);
	const registry = create(resolveCredential);
	const coverage = PROVIDER_DELIVERY_COVERAGE.find(
		(row) => row.providerId === providerId,
	);
	const allowed = new Set(
		coverage?.realization === "resolver" ? coverage.resolvedProductIds : [],
	);
	for (const resolver of registry.list())
		if (resolver.providerId !== providerId || !allowed.has(resolver.productId))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`${providerId} registry returned ${resolver.providerId}:${resolver.productId}, outside its declared delivery coverage. Remediation: bind the provider package's own <name>ResolverRegistry`,
				resolver.productId,
			);
	return registry;
}
