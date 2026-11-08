import { createHash } from "node:crypto";
import {
	type ClaimableOperationKeyDeriver,
	createBoundedFetchTransport,
	createClaimableOperationKeyDeriver,
	createResolverRegistry,
	type HttpTransport,
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
import { createNeonClaimableResolver } from "@hobo/provider-neon";
import {
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
	type NetlifyResolverOptions,
	netlifyResolverRegistry,
} from "@hobo/provider-netlify";
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
	  >;

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
	neon: "@hobo/provider-neon",
	prisma: "@hobo/provider-prisma-postgres",
	upstash: "@hobo/provider-upstash",
});

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
			expected = `${entry.providerId}://accounts/${entry.lease.binding.providerAccountId}`;
	}
	if (
		entry.lease.binding.providerId !== entry.providerId ||
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
): ReadonlyMap<string, ProductionResolverBinding> {
	const result = new Map<string, ProductionResolverBinding>();
	for (const entry of entries) {
		verifyNativeScope(entry);
		if (result.has(entry.providerId))
			throw new Error("duplicate production provider scope");
		const lease = entry.lease;
		const nativeId = entry.providerId;
		const manifestId = MANIFEST_IDS[nativeId];
		if (
			!(entry.observeOperatingLiability instanceof Function) ||
			(entry.observeLifecycle !== undefined &&
				!(entry.observeLifecycle instanceof Function))
		)
			throw new Error(
				"production catalog requires authenticated financial readers",
			);
		const extras: ScopeLease[] = [];
		let registry: ProductionResolverBinding["registry"];
		switch (entry.providerId) {
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
				return prepareHostingProviderDesired(nativeId, input);
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
		result.set(entry.providerId, binding);
		result.set(manifestId, binding);
	}
	return result;
}
