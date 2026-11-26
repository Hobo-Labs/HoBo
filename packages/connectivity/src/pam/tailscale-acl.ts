/**
 * Pure Tailscale ACL document for environment network isolation.
 * Apply via Tailscale API (createTailscaleApiClient) when credentials present.
 */

import type { IsolationClass } from "../env-isolation/types.js";
import { ISOLATION_CLASSES } from "../env-isolation/types.js";
import type { JsonValue } from "../json.js";

// public-contract: generated ACL schema version.
export const ENV_ISOLATION_TAILSCALE_ACL_SCHEMA =
	"hobo.env-isolation-tailscale-acl/v1" as const;

export type TailscaleAclGrant = Readonly<{
	src: readonly string[];
	dst: readonly string[];
	ip?: readonly string[];
}>;

export type EnvIsolationTailscaleAcl = Readonly<{
	schemaVersion: typeof ENV_ISOLATION_TAILSCALE_ACL_SCHEMA;
	/** tagOwners for env isolation tags. */
	tagOwners: Readonly<Record<string, readonly string[]>>;
	/** Default deny across env tags; same-env allow. */
	acls: readonly TailscaleAclGrant[];
	/** Optional via routes — never sufficient alone for production. */
	via?: readonly string[];
	/** Human-readable notes for operators. */
	notes: readonly string[];
}>;

/**
 * Render a fail-closed Tailscale ACL: each isolation class can only talk to itself
 * unless an explicit cross-env grant tag is present (time-bound grants are policy-side).
 */
export function renderEnvIsolationTailscaleAcl(input?: {
	readonly classes?: readonly IsolationClass[];
	readonly tagOwnerGroup?: string;
	readonly crossEnvGrantTags?: readonly {
		readonly from: IsolationClass;
		readonly to: IsolationClass;
		readonly grantTag: string;
	}[];
}): EnvIsolationTailscaleAcl {
	const classes = input?.classes ?? ISOLATION_CLASSES;
	const owner = input?.tagOwnerGroup ?? "group:hobo-control-plane";
	const tagOwners: Record<string, readonly string[]> = {};
	const acls: TailscaleAclGrant[] = [];

	for (const cls of classes) {
		// Tailscale tags use tag:name form; map env:production → tag:env-production
		const tsTag = `tag:env-${cls}`;
		tagOwners[tsTag] = Object.freeze([owner]);
		// Same-env allow (src=dst tag).
		acls.push(
			Object.freeze({
				src: Object.freeze([tsTag]),
				dst: Object.freeze([`${tsTag}:*`]),
				ip: Object.freeze(["*"]),
			}),
		);
	}

	// Explicit cross-env grant tags (optional, time-bound membership is still required in PolicyEngine).
	for (const g of input?.crossEnvGrantTags ?? []) {
		const grantTag = g.grantTag.startsWith("tag:")
			? g.grantTag
			: `tag:${g.grantTag}`;
		tagOwners[grantTag] = Object.freeze([owner]);
		acls.push(
			Object.freeze({
				src: Object.freeze([grantTag, `tag:env-${g.from}`]),
				dst: Object.freeze([`tag:env-${g.to}:*`]),
				ip: Object.freeze(["*"]),
			}),
		);
	}

	// Local-dev has no remote overlay peers by policy note.
	return Object.freeze({
		schemaVersion: ENV_ISOLATION_TAILSCALE_ACL_SCHEMA,
		tagOwners: Object.freeze(tagOwners),
		acls: Object.freeze(acls),
		notes: Object.freeze([
			"Soft floor: PolicyEngine still denies cross-env without elevated capability.",
			"Network ACL is a signal — production access requires ElevatedAccessCapability.",
			"local-dev must not appear on shared production tailnets.",
			"Apply with Tailscale policy API or admin console; never auto-widen.",
		]),
	});
}

/**
 * Apply generated ACL tagOwners merge into a Tailscale split-DNS / policy document
 * shape operators can PUT. Does not call the network unless client provided.
 */
export async function applyEnvIsolationAclHints(input: {
	readonly acl: EnvIsolationTailscaleAcl;
	/** Optional live client — when present, set DNS preferences for env zones only. */
	readonly tailscale?: {
		readonly setDnsPreferences: (prefs: {
			readonly magicDNS?: boolean;
		}) => Promise<JsonValue>;
		readonly putSplitDns?: (
			domains: readonly string[],
			nameservers: readonly string[],
		) => Promise<JsonValue>;
	};
}): Promise<{
	readonly applied: boolean;
	readonly document: EnvIsolationTailscaleAcl;
	readonly notes: readonly string[];
}> {
	const notes: string[] = [...input.acl.notes];
	if (!input.tailscale) {
		return {
			applied: false,
			document: input.acl,
			notes: Object.freeze([
				...notes,
				"No Tailscale client provided — ACL document returned for manual apply.",
			]),
		};
	}
	await input.tailscale.setDnsPreferences({ magicDNS: true });
	if (input.tailscale.putSplitDns) {
		// Env-scoped hierarchical names stay on operator-configured resolvers.
		await input.tailscale.putSplitDns(
			["hobo.test", "hobo.internal"],
			["100.100.100.100"],
		);
	}
	return {
		applied: true,
		document: input.acl,
		notes: Object.freeze([
			...notes,
			"DNS preferences applied; full ACL JSON must be reviewed then pushed via Tailscale policy API.",
		]),
	};
}
