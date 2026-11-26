/**
 * Host allowlisting for provider-returned URLs.
 *
 * This provider has no documented REST API — the pinned `create-db` CLI makes
 * the HTTPS calls. What crosses back into HoBo is a claim URL and a connection
 * host, and both are attacker-influenced the moment the CLI is compromised or
 * its output is tampered with. So they are checked against the official hosts
 * with the same rules a transport would apply: HTTPS, exact host, no userinfo,
 * default port, and no redirect ever followed by this package.
 */
import { PrismaProviderError } from "./errors.js";

/** Official hosts, from https://docs.prisma.io/docs/postgres/npx-create-db. */
export const PRISMA_CLAIM_HOSTS = ["create-db.prisma.io"] as const;
export const PRISMA_DATABASE_HOSTS = ["db.prisma.io"] as const;

export type UrlPolicy = {
	readonly allowedHosts: readonly string[];
	readonly maxLength: number;
};

export const DEFAULT_CLAIM_URL_POLICY: UrlPolicy = {
	allowedHosts: PRISMA_CLAIM_HOSTS,
	maxLength: 512,
};

/**
 * Parse a provider-supplied URL against the policy. This package never issues
 * a request to the result — it is recorded and shown to a human — but an
 * unchecked `claim_url` is a phishing link with HoBo's name on it.
 */
export function assertAllowedProviderUrl(
	value: string,
	policy: UrlPolicy,
): URL {
	if (value.length === 0 || value.length > policy.maxLength) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`provider url must be 1-${policy.maxLength} characters`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider url is not a valid URL",
		);
	}
	if (parsed.protocol !== "https:") {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`provider url must use https, got ${parsed.protocol.replace(":", "")}`,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"provider url must not embed userinfo",
		);
	}
	if (parsed.port !== "" && parsed.port !== "443") {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`provider url must use the default https port, got ${parsed.port}`,
		);
	}
	const host = parsed.hostname.toLowerCase();
	if (!policy.allowedHosts.includes(host)) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`host ${host} is not an allowlisted official provider host`,
			{ detail: { host, allowed: policy.allowedHosts.join(",") } },
		);
	}
	return parsed;
}

export function assertAllowedDatabaseHost(host: string): string {
	const lowered = host.toLowerCase();
	// SAFETY: value was established by the surrounding parse or typed constructor.
	if (!(PRISMA_DATABASE_HOSTS as readonly string[]).includes(lowered)) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`connection host ${lowered} is not an allowlisted official Prisma Postgres host`,
			{ detail: { host: lowered, allowed: PRISMA_DATABASE_HOSTS.join(",") } },
		);
	}
	return lowered;
}
