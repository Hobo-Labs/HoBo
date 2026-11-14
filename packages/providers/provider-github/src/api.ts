/**
 * Which GitHub REST API a resolver is bound to, parsed once.
 *
 * The host binds the API origin; a plan never names it. github.com is
 * `https://api.github.com`; GitHub Enterprise Server is `<origin>/api/v3`.
 * The derived `GithubApiTarget` carries the transport guard policy, pinned to
 * that one host and to `/repos/` under the API base — the only subtree this
 * realizer calls — so a hostile plan cannot point the token anywhere else.
 */
import type { TransportGuardPolicy } from "@hobo/core";
import { unsupported } from "./errors.js";

// public-contract: the closed set of GitHub API kinds this realizer binds.
export const GITHUB_API_KINDS = Object.freeze(["github.com", "ghes"] as const);
export type GithubApiKind = (typeof GITHUB_API_KINDS)[number];

// public-contract: the github.com REST API origin.
export const GITHUB_COM_API_ORIGIN = "https://api.github.com";
// public-contract: the REST API version every request pins.
export const GITHUB_API_VERSION = "2022-11-28";

/** Recursive tree listings of large sites run to megabytes; bounded here. */
export const GITHUB_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const GITHUB_TIMEOUT_MS = 60_000;

/** What a host supplies. GHES names its web origin; the API lives at /api/v3. */
export type GithubApiBinding =
	| { readonly kind: "github.com" }
	| { readonly kind: "ghes"; readonly origin: string };

// domain-view: parse-time derived API target; never read from a plan.
export interface GithubApiTarget {
	readonly kind: GithubApiKind;
	/** API base, no trailing slash: `https://api.github.com` or `https://host/api/v3`. */
	readonly base: string;
	readonly policy: TransportGuardPolicy;
}

export function parseGithubApiBinding(
	binding: GithubApiBinding,
): GithubApiTarget {
	switch (binding?.kind) {
		case "github.com":
			return target("github.com", new URL(GITHUB_COM_API_ORIGIN), "");
		case "ghes":
			return target("ghes", ghesOrigin(binding.origin), "/api/v3");
		default:
			return unsupported(
				`GitHub API binding ${JSON.stringify(binding)} is not one of ${GITHUB_API_KINDS.join(", ")}`,
				"bind github.com or a ghes origin",
			);
	}
}

function ghesOrigin(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return unsupported(
			"GHES origin is not a URL",
			"bind an https://host[:port] origin",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		(url.pathname !== "/" && url.pathname !== "")
	)
		unsupported(
			"GHES origin must be https with no path, credentials, query or fragment",
			"bind an https://host[:port] origin; credentials travel only through credentialRef",
		);
	return url;
}

function target(
	kind: GithubApiKind,
	url: URL,
	apiPath: string,
): GithubApiTarget {
	return Object.freeze({
		kind,
		base: `${url.protocol}//${url.host}${apiPath}`,
		policy: Object.freeze({
			allowedHosts: Object.freeze([url.hostname]),
			allowedPathPrefixes: Object.freeze([`${apiPath}/repos/`]),
			maxTimeoutMs: GITHUB_TIMEOUT_MS,
			maxResponseBytes: GITHUB_MAX_RESPONSE_BYTES,
			...(url.port === ""
				? undefined
				: { allowedPorts: Object.freeze([url.port]) }),
		}),
	});
}
