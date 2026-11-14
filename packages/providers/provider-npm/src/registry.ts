/**
 * Which npm-compatible registry a resolver is bound to, parsed once.
 *
 * Parse, don't validate: a host hands a `NpmRegistryBinding` (plain data) and
 * gets back a `NpmRegistryTarget`, a derived type whose origin, guard policy
 * and capability facts are fixed. The resolver never reads a registry URL from
 * a plan: desired state may only *name* the bound origin, and a mismatch is a
 * refusal. That is what keeps a hostile plan from pointing a publish token at
 * someone else's registry.
 *
 * Capability facts are honest per registry:
 *
 * | Registry | OIDC trusted publishing | Provenance | Scope required |
 * |---|---|---|---|
 * | `npmjs` (`registry.npmjs.org`) | yes | yes (Sigstore attachment) | no |
 * | `github-packages` (`npm.pkg.github.com`) | no | no | yes |
 * | `verdaccio` (operator origin) | no | no | no |
 */
import type { TransportGuardPolicy } from "@hobo/core";
import { unsupported } from "./errors.js";

// public-contract: the closed set of npm-compatible registries this realizer binds.
export const NPM_REGISTRY_KINDS = Object.freeze([
	"npmjs",
	"github-packages",
	"verdaccio",
] as const);
export type NpmRegistryKind = (typeof NPM_REGISTRY_KINDS)[number];

// public-contract: the public npm registry origin.
export const NPMJS_REGISTRY_ORIGIN = "https://registry.npmjs.org";
// public-contract: the GitHub Packages npm registry origin.
export const GITHUB_PACKAGES_NPM_ORIGIN = "https://npm.pkg.github.com";

/** What a host supplies. Verdaccio is self-hosted, so it names its origin. */
export type NpmRegistryBinding =
	| { readonly kind: "npmjs" }
	| { readonly kind: "github-packages" }
	| { readonly kind: "verdaccio"; readonly origin: string };

// domain-view: parse-time derived registry target; never read from a plan.
export interface NpmRegistryTarget {
	readonly kind: NpmRegistryKind;
	/** Origin plus base path, no trailing slash: `https://host[:port][/base]`. */
	readonly base: string;
	readonly policy: TransportGuardPolicy;
	readonly supportsOidcTrustedPublishing: boolean;
	readonly supportsProvenance: boolean;
	readonly requiresScope: boolean;
}

/** Packuments of popular packages run to tens of MiB; ours are bounded here. */
export const NPM_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const NPM_TIMEOUT_MS = 120_000;

export function parseNpmRegistryBinding(
	binding: NpmRegistryBinding,
): NpmRegistryTarget {
	switch (binding?.kind) {
		case "npmjs":
			return target("npmjs", new URL(NPMJS_REGISTRY_ORIGIN), true, true, false);
		case "github-packages":
			return target(
				"github-packages",
				new URL(GITHUB_PACKAGES_NPM_ORIGIN),
				false,
				false,
				true,
			);
		case "verdaccio":
			return target(
				"verdaccio",
				verdaccioOrigin(binding.origin),
				false,
				false,
				false,
			);
		default:
			return unsupported(
				`npm registry binding ${JSON.stringify(binding)} is not one of ${NPM_REGISTRY_KINDS.join(", ")}`,
				"bind the Camp to npmjs, github-packages, or a verdaccio origin",
			);
	}
}

function verdaccioOrigin(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return unsupported(
			"verdaccio origin is not a URL",
			"bind an https://host[:port][/base] origin",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	)
		unsupported(
			"verdaccio origin must be https with no credentials, query or fragment",
			"bind an https://host[:port][/base] origin; credentials travel only through credentialRef",
		);
	return url;
}

function target(
	kind: NpmRegistryKind,
	url: URL,
	supportsOidcTrustedPublishing: boolean,
	supportsProvenance: boolean,
	requiresScope: boolean,
): NpmRegistryTarget {
	const basePath = url.pathname.endsWith("/")
		? url.pathname
		: `${url.pathname}/`;
	const base = `${url.protocol}//${url.host}${basePath}`.replace(/\/$/u, "");
	return Object.freeze({
		kind,
		base,
		policy: Object.freeze({
			allowedHosts: Object.freeze([url.hostname]),
			allowedPathPrefixes: Object.freeze([basePath]),
			maxTimeoutMs: NPM_TIMEOUT_MS,
			maxResponseBytes: NPM_MAX_RESPONSE_BYTES,
			...(url.port === ""
				? undefined
				: { allowedPorts: Object.freeze([url.port]) }),
		}),
		supportsOidcTrustedPublishing,
		supportsProvenance,
		requiresScope,
	});
}
