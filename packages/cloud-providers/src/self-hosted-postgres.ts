/**
 * Which registered compute providers could host a self-managed PostgreSQL —
 * answered from what each provider package declares, not from its name.
 *
 * This is a read model in the same spirit as `parity.ts`: both halves of every
 * row are read off code. The compute half is the provider package's own
 * `EQUIVALENCE_CLASSES` — the table its Capability Manifest publishes — taking
 * every class on the `compute` port. The catalog half is the provider's full
 * allocatable Yard (`PARITY_SOURCES`), reduced to `(profile, productId)`. The
 * verdict is `assessSelfHostedDataStore` from `@hobo/core`, which never sees a
 * rule keyed on a provider id.
 *
 * REGISTRY: the providers assessed are the nine `PARITY_PROVIDERS` (every
 * namespace with a Yard catalog) plus Netlify and Railway, which publish
 * compute equivalence classes but no Yard catalog here, so their catalog half
 * is empty. Neon, Prisma Postgres, Upstash and Convex are data backends, not
 * compute, and are not hosts.
 *
 * HONEST SCOPE: a verdict is a statement about the *declaration*. `cannot`
 * means nothing this provider has registered with HoBo is a VM or a container;
 * `undetermined` means a container is declared but the declaration does not
 * say whether it stays up, keeps a disk, or accepts TCP. Neither is a claim
 * about what the vendor sells. Nothing here provisions anything.
 */
import {
	assessSelfHostedDataStore,
	type RegisteredCatalogRow,
	type RegisteredComputeCapability,
	type RegisteredHostDeclaration,
	type SelfHostAssessment,
} from "@hobo/core";
import { EQUIVALENCE_CLASSES as AWS } from "@hobo/provider-aws";
import { EQUIVALENCE_CLASSES as AZURE } from "@hobo/provider-azure";
import { EQUIVALENCE_CLASSES as CLOUDFLARE } from "@hobo/provider-cloudflare";
import { EQUIVALENCE_CLASSES as DIGITALOCEAN } from "@hobo/provider-digitalocean";
import { EQUIVALENCE_CLASSES as GCP } from "@hobo/provider-gcp";
import { EQUIVALENCE_CLASSES as HETZNER } from "@hobo/provider-hetzner";
import { EQUIVALENCE_CLASSES as HOSTINGER } from "@hobo/provider-hostinger";
import { EQUIVALENCE_CLASSES as KUBERNETES } from "@hobo/provider-kubernetes";
import { EQUIVALENCE_CLASSES as NETLIFY } from "@hobo/provider-netlify";
import { EQUIVALENCE_CLASSES as RAILWAY } from "@hobo/provider-railway";
import { EQUIVALENCE_CLASSES as VERCEL } from "@hobo/provider-vercel";

import { PARITY_PROVIDERS, PARITY_SOURCES } from "./parity.js";

/** One equivalence class as every provider package publishes it. */
export interface EquivalenceClassLike {
	readonly port: string;
	readonly resourceClass: string;
	readonly providerService: string;
	readonly features: readonly string[];
}

export interface SelfHostSource {
	readonly equivalenceClasses: Readonly<Record<string, EquivalenceClassLike>>;
	/** The provider's Yard catalog rows; empty when it publishes no Yard here. */
	readonly catalog: () => readonly RegisteredCatalogRow[];
}

// public-contract: the port name whose equivalence classes are compute hosts.
export const COMPUTE_PORT = "compute";

// public-contract: providers assessed as self-host targets, in report order.
export const SELF_HOST_PROVIDERS = Object.freeze([
	...PARITY_PROVIDERS,
	"netlify",
	"railway",
] as const);

export type SelfHostProvider = (typeof SELF_HOST_PROVIDERS)[number];

function yardRows(provider: (typeof PARITY_PROVIDERS)[number]) {
	return () =>
		PARITY_SOURCES[provider]
			.catalog()
			.bindings.map((binding) =>
				binding.productId === undefined
					? { profile: binding.profile }
					: { profile: binding.profile, productId: binding.productId },
			);
}

const noYard = () => [];

/** Where each provider's two halves are read from. */
export const SELF_HOST_SOURCES: Readonly<
	Record<SelfHostProvider, SelfHostSource>
> = Object.freeze({
	aws: { equivalenceClasses: AWS, catalog: yardRows("aws") },
	azure: { equivalenceClasses: AZURE, catalog: yardRows("azure") },
	cloudflare: {
		equivalenceClasses: CLOUDFLARE,
		catalog: yardRows("cloudflare"),
	},
	digitalocean: {
		equivalenceClasses: DIGITALOCEAN,
		catalog: yardRows("digitalocean"),
	},
	gcp: { equivalenceClasses: GCP, catalog: yardRows("gcp") },
	hetzner: { equivalenceClasses: HETZNER, catalog: yardRows("hetzner") },
	hostinger: { equivalenceClasses: HOSTINGER, catalog: yardRows("hostinger") },
	kubernetes: {
		equivalenceClasses: KUBERNETES,
		catalog: yardRows("kubernetes"),
	},
	vercel: { equivalenceClasses: VERCEL, catalog: yardRows("vercel") },
	netlify: { equivalenceClasses: NETLIFY, catalog: noYard },
	railway: { equivalenceClasses: RAILWAY, catalog: noYard },
});

/** A provider's declaration, reduced to what the self-host question reads. */
export function registeredHostDeclaration(
	provider: SelfHostProvider,
): RegisteredHostDeclaration {
	const source = SELF_HOST_SOURCES[provider];
	const compute: RegisteredComputeCapability[] = Object.values(
		source.equivalenceClasses,
	)
		.filter((entry) => entry.port === COMPUTE_PORT)
		.map((entry) =>
			Object.freeze({
				resourceClass: entry.resourceClass,
				providerService: entry.providerService,
				features: Object.freeze([...entry.features]),
			}),
		);
	return Object.freeze({
		providerId: provider,
		compute: Object.freeze(compute),
		catalog: Object.freeze(source.catalog().map((row) => Object.freeze(row))),
	});
}

/** Every assessed provider's declaration, in {@link SELF_HOST_PROVIDERS} order. */
export function registeredHostDeclarations(): readonly RegisteredHostDeclaration[] {
	return Object.freeze(SELF_HOST_PROVIDERS.map(registeredHostDeclaration));
}

/** The self-host verdict for every assessed provider, with reasons. */
export function selfHostedPostgresHosts(): readonly SelfHostAssessment[] {
	return Object.freeze(
		registeredHostDeclarations().map(assessSelfHostedDataStore),
	);
}
