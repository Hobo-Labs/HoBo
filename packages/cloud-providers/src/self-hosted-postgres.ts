import {
	assessSelfHostedDataStore,
	type RegisteredCatalogRow,
	type RegisteredComputeCapability,
	type RegisteredHostDeclaration,
	type RegisteredHostForm,
	type SelfHostAssessment,
} from "@hobo/core";
import { EQUIVALENCE_CLASSES as AWS, AWS_HOST_FORMS } from "@hobo/provider-aws";
import {
	EQUIVALENCE_CLASSES as AZURE,
	AZURE_HOST_FORMS,
} from "@hobo/provider-azure";
import { EQUIVALENCE_CLASSES as CLOUDFLARE } from "@hobo/provider-cloudflare";
import {
	EQUIVALENCE_CLASSES as DIGITALOCEAN,
	DIGITALOCEAN_HOST_FORMS,
} from "@hobo/provider-digitalocean";
import { EQUIVALENCE_CLASSES as GCP, GCP_HOST_FORMS } from "@hobo/provider-gcp";
import { EQUIVALENCE_CLASSES as HETZNER } from "@hobo/provider-hetzner";
import { EQUIVALENCE_CLASSES as HOSTINGER } from "@hobo/provider-hostinger";
import {
	EQUIVALENCE_CLASSES as KUBERNETES,
	KUBERNETES_HOST_FORMS,
} from "@hobo/provider-kubernetes";
import { EQUIVALENCE_CLASSES as NETLIFY } from "@hobo/provider-netlify";
import {
	EQUIVALENCE_CLASSES as RAILWAY,
	RAILWAY_HOST_FORMS,
} from "@hobo/provider-railway";
import { EQUIVALENCE_CLASSES as VERCEL } from "@hobo/provider-vercel";

import { PARITY_PROVIDERS, PARITY_SOURCES } from "./parity.js";

export interface EquivalenceClassLike {
	readonly port: string;
	readonly resourceClass: string;
	readonly providerService: string;
	readonly features: readonly string[];
}

export interface SelfHostSource {
	readonly equivalenceClasses: Readonly<Record<string, EquivalenceClassLike>>;
	readonly hostForms?: readonly RegisteredHostForm[];
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

export const SELF_HOST_SOURCES: Readonly<
	Record<SelfHostProvider, SelfHostSource>
> = Object.freeze({
	aws: {
		equivalenceClasses: AWS,
		hostForms: AWS_HOST_FORMS,
		catalog: yardRows("aws"),
	},
	azure: {
		equivalenceClasses: AZURE,
		hostForms: AZURE_HOST_FORMS,
		catalog: yardRows("azure"),
	},
	cloudflare: {
		equivalenceClasses: CLOUDFLARE,
		catalog: yardRows("cloudflare"),
	},
	digitalocean: {
		equivalenceClasses: DIGITALOCEAN,
		hostForms: DIGITALOCEAN_HOST_FORMS,
		catalog: yardRows("digitalocean"),
	},
	gcp: {
		equivalenceClasses: GCP,
		hostForms: GCP_HOST_FORMS,
		catalog: yardRows("gcp"),
	},
	hetzner: { equivalenceClasses: HETZNER, catalog: yardRows("hetzner") },
	hostinger: { equivalenceClasses: HOSTINGER, catalog: yardRows("hostinger") },
	kubernetes: {
		equivalenceClasses: KUBERNETES,
		hostForms: KUBERNETES_HOST_FORMS,
		catalog: yardRows("kubernetes"),
	},
	vercel: { equivalenceClasses: VERCEL, catalog: yardRows("vercel") },
	netlify: { equivalenceClasses: NETLIFY, catalog: noYard },
	railway: {
		equivalenceClasses: RAILWAY,
		hostForms: RAILWAY_HOST_FORMS,
		catalog: noYard,
	},
});

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
		hostForms: source.hostForms ?? Object.freeze([]),
	});
}

export function registeredHostDeclarations(): readonly RegisteredHostDeclaration[] {
	return Object.freeze(SELF_HOST_PROVIDERS.map(registeredHostDeclaration));
}

export function selfHostedPostgresHosts(): readonly SelfHostAssessment[] {
	return Object.freeze(
		registeredHostDeclarations().map(assessSelfHostedDataStore),
	);
}
