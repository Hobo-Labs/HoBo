/**
 * The strict allowlist of resources a Cloudflare temporary (preview) account
 * may hold, transcribed from the published "Supported resources" table.
 *
 * Everything not in the table fails closed. Cloudflare states plainly that
 * "temporary credentials do not grant every operation for these resources", so
 * an absent product is never treated as "probably works" — it is a refusal with
 * a `RESOURCE_NOT_SUPPORTED` code until the doc and a conformance run say
 * otherwise.
 */
import { TemporaryAccountError } from "./temporary-account-errors.js";

/** Official source for every number and capability in this module. */
// public-contract: authoritative provider documentation source.
export const CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL =
	"https://developers.cloudflare.com/workers/platform/claim-deployments/";

/** Date a human re-read {@link CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL}. */
// public-contract: dates the provider evidence snapshot.
export const CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT = "2026-08-08";

/** "Last updated" stamp the doc itself carried on the checked date. */
// public-contract: provider-reported documentation revision date.
export const CLOUDFLARE_TEMPORARY_ACCOUNT_DOC_UPDATED_AT = "2026-07-14";

/** Documented claim window. Recorded as documentation, never as a live timer. */
export const CLOUDFLARE_DOCUMENTED_CLAIM_WINDOW_MINUTES = 60;

/** Cloudflare's own bound on proof-of-work: reject a challenge above `k * g`. */
export const CLOUDFLARE_MAX_PROOF_OF_WORK = 64_000_000;

export const TEMPORARY_ACCOUNT_RESOURCE_KINDS = [
	"workers",
	"workers-static-assets",
	"workers-kv",
	"d1",
	"durable-objects",
	"hyperdrive",
	"queues",
	"certificates",
] as const;

export type TemporaryAccountResourceKind =
	(typeof TEMPORARY_ACCOUNT_RESOURCE_KINDS)[number];

export type TemporaryAccountResourceLimit = {
	readonly key: string;
	readonly value: number;
	/** Unit exactly as the doc words it. Never re-derived into other units. */
	readonly unit: "count" | "mebibytes" | "megabytes" | "connections";
};

export type TemporaryAccountResource = {
	readonly kind: TemporaryAccountResourceKind;
	readonly displayName: string;
	/** The doc's own "Supported capability or limit" cell, verbatim. */
	readonly documentedCapability: string;
	readonly limits: readonly TemporaryAccountResourceLimit[];
	readonly sourceUrl: string;
	readonly checkedAt: string;
};

const source = {
	sourceUrl: CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL,
	checkedAt: CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT,
} as const;

/**
 * The allowlist. Order matches the published table so a doc diff is easy to
 * reconcile against this file.
 */
export const CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWLIST: readonly TemporaryAccountResource[] =
	Object.freeze([
		{
			kind: "workers",
			displayName: "Workers",
			documentedCapability: "Deployments on workers.dev",
			limits: [],
			...source,
		},
		{
			kind: "workers-static-assets",
			displayName: "Workers Static Assets",
			documentedCapability: "Up to 1,000 files, with each asset up to 5 MiB",
			limits: [
				{ key: "maxFileCount", value: 1000, unit: "count" },
				{ key: "maxFileMebibytes", value: 5, unit: "mebibytes" },
			],
			...source,
		},
		{
			kind: "workers-kv",
			displayName: "Workers KV",
			documentedCapability:
				"Create, list, rename, and delete namespaces; put, get, list, and delete keys; bulk put, get, and delete",
			limits: [],
			...source,
		},
		{
			kind: "d1",
			displayName: "D1",
			documentedCapability:
				"One database, with up to 100 MB per database and 100 MB total",
			limits: [
				{ key: "maxDatabaseCount", value: 1, unit: "count" },
				{ key: "maxDatabaseMegabytes", value: 100, unit: "megabytes" },
				{ key: "maxTotalMegabytes", value: 100, unit: "megabytes" },
			],
			...source,
		},
		{
			kind: "durable-objects",
			displayName: "Durable Objects",
			documentedCapability:
				"Deploy Workers with Durable Object bindings and migrations",
			limits: [],
			...source,
		},
		{
			kind: "hyperdrive",
			displayName: "Hyperdrive",
			documentedCapability:
				"Up to two database configurations and 10 connections",
			limits: [
				{ key: "maxConfigurations", value: 2, unit: "count" },
				{ key: "maxConnections", value: 10, unit: "connections" },
			],
			...source,
		},
		{
			kind: "queues",
			displayName: "Queues",
			documentedCapability: "Up to 10 queues",
			limits: [{ key: "maxQueues", value: 10, unit: "count" }],
			...source,
		},
		{
			kind: "certificates",
			displayName: "mTLS and CA certificates",
			documentedCapability: "wrangler cert upload, list, and delete operations",
			limits: [],
			...source,
		},
	] as const);

/**
 * Products that are explicitly refused.
 *
 * Each entry was checked against the published table on
 * {@link CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT} and found absent. Absence from
 * the table is the evidence; nothing here is a guess about Cloudflare's roadmap.
 *
 * Corroborating: wrangler registers `--temporary` only on the commands the
 * preview token can serve — Workers, KV, D1, Hyperdrive, Queues, and certs —
 * with "Pages/R2/AI/etc. aren't" stated in the same change
 * (cloudflare/workers-sdk commit 1664d46, read 2026-08-08).
 */
export const CLOUDFLARE_TEMPORARY_ACCOUNT_DENYLIST: readonly {
	readonly kind: string;
	readonly reason: string;
}[] = Object.freeze([
	{ kind: "r2", reason: "absent from the published supported-resources table" },
	{
		kind: "containers",
		reason:
			"absent from the published supported-resources table; temporary Containers apply is observed to return 403",
	},
	{
		kind: "vectorize",
		reason: "absent from the published supported-resources table",
	},
	{
		kind: "workers-ai",
		reason: "absent from the published supported-resources table",
	},
	{
		kind: "secrets-store",
		reason: "absent from the published supported-resources table",
	},
	{
		kind: "cron-triggers",
		reason:
			"absent from the published supported-resources table; scheduled execution needs its own product evidence",
	},
	{
		kind: "custom-domains",
		reason:
			"the doc restricts deployments to workers.dev until the account is claimed",
	},
] as const);

const BY_KIND = new Map<string, TemporaryAccountResource>(
	CLOUDFLARE_TEMPORARY_ACCOUNT_ALLOWLIST.map((resource) => [
		resource.kind,
		resource,
	]),
);

const DENY_REASON = new Map<string, string>(
	CLOUDFLARE_TEMPORARY_ACCOUNT_DENYLIST.map((entry) => [
		entry.kind,
		entry.reason,
	]),
);

export function isTemporaryAccountResourceAllowed(
	kind: string,
): kind is TemporaryAccountResourceKind {
	return BY_KIND.has(kind);
}

/**
 * Fail-closed gate. Anything outside the table is refused, whether or not it
 * appears on the explicit denylist — an unknown product name is not a licence.
 */
export function assertTemporaryAccountResourceAllowed(
	kind: string,
): TemporaryAccountResource {
	const resource = BY_KIND.get(kind);
	if (resource !== undefined) return resource;
	const documented = DENY_REASON.get(kind);
	throw new TemporaryAccountError(
		"RESOURCE_NOT_SUPPORTED",
		`Cloudflare temporary accounts do not support ${JSON.stringify(kind)}: ${
			documented ?? "not listed in the published supported-resources table"
		} (${CLOUDFLARE_TEMPORARY_ACCOUNT_SOURCE_URL}, checked ${CLOUDFLARE_TEMPORARY_ACCOUNT_CHECKED_AT})`,
		{
			reason:
				documented !== undefined ? "EXPLICITLY_DENIED" : "NOT_IN_ALLOWLIST",
		},
	);
}

export type TemporaryAccountResourceRequest = {
	readonly kind: string;
	/** Requested quantities keyed by the limit keys in the allowlist. */
	readonly quantities?: Readonly<Record<string, number>>;
};

/** Allowlist gate plus the documented numeric ceilings for the resource. */
export function assertTemporaryAccountResourceRequest(
	request: TemporaryAccountResourceRequest,
): TemporaryAccountResource {
	const resource = assertTemporaryAccountResourceAllowed(request.kind);
	for (const [key, requested] of Object.entries(request.quantities ?? {})) {
		const limit = resource.limits.find((entry) => entry.key === key);
		if (limit === undefined) {
			throw new TemporaryAccountError(
				"RESOURCE_NOT_SUPPORTED",
				`${resource.displayName} has no documented ${JSON.stringify(key)} limit in temporary accounts`,
				{ reason: "UNKNOWN_LIMIT_KEY" },
			);
		}
		if (!Number.isFinite(requested) || requested < 0) {
			throw new TemporaryAccountError(
				"RESOURCE_NOT_SUPPORTED",
				`requested ${key} for ${resource.displayName} must be a non-negative number`,
				{ reason: "INVALID_QUANTITY" },
			);
		}
		if (requested > limit.value) {
			throw new TemporaryAccountError(
				"RESOURCE_NOT_SUPPORTED",
				`${resource.displayName} allows at most ${limit.value} ${limit.unit} for ${key} in a temporary account, ${requested} requested`,
				{ reason: "LIMIT_EXCEEDED" },
			);
		}
	}
	return resource;
}
