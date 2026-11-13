/**
 * `PrincipalDirectory` implementations (§6.5 "People sign in", §6.13): which
 * tenants a signed-in principal belongs to and with which tags. Two sources,
 * both from configuration:
 *
 * - static entries naming a principal (`<kind>:<id>`), its tenant, tags and
 *   aliases (other names the same person signs in under);
 * - claim rules: a provider claim (for example an OIDC `groups` claim or a
 *   GitHub `org` claim) whose value, as a comma- or space-separated list,
 *   contains `equals`, grants the rule's tags in its tenant.
 *
 * `combineDirectories` merges answers per tenant (tags and aliases unioned).
 */
import { type PrincipalRef, parseTenantId, type TenantId } from "@hobo/core";
import type { PrincipalDirectory } from "@hobo/fleet";

// domain-view: one configured directory entry, before the tenant id is parsed.
export type DirectoryEntry = Readonly<{
	principal: string;
	tenant: string;
	tags: readonly string[];
	aliases?: readonly string[];
}>;

// domain-view: one configured claim rule.
export type ClaimRule = Readonly<{
	tenant: string;
	/** Only principals signed in through this provider's claims; any when absent. */
	issuer?: string | undefined;
	claim: string;
	equals: string;
	tags: readonly string[];
}>;

type Answer = Readonly<{
	tenant: TenantId;
	tags: readonly string[];
	aliases: readonly string[];
}>;

function principalText(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function createStaticPrincipalDirectory(
	entries: readonly DirectoryEntry[],
): PrincipalDirectory {
	const parsed = entries.map((entry) => ({
		principal: entry.principal,
		tenant: parseTenantId(entry.tenant),
		tags: [...entry.tags],
		aliases: [...(entry.aliases ?? [])],
	}));
	return {
		async tenantsOf(principal) {
			const text = principalText(principal);
			return parsed
				.filter(
					(entry) => entry.principal === text || entry.aliases.includes(text),
				)
				.map((entry) => ({
					tenant: entry.tenant,
					tags: entry.tags,
					aliases: entry.aliases.filter((alias) => alias !== text),
				}));
		},
	};
}

export function createClaimPrincipalDirectory(
	rules: readonly ClaimRule[],
): PrincipalDirectory {
	const parsed = rules.map((rule) => ({
		...rule,
		tenantId: parseTenantId(rule.tenant),
	}));
	return {
		async tenantsOf(_principal, claims) {
			const answers: Answer[] = [];
			for (const rule of parsed) {
				if (rule.issuer !== undefined && claims.iss !== rule.issuer) continue;
				const values = (claims[rule.claim] ?? "")
					.split(/[\s,]+/u)
					.filter((value) => value.length > 0);
				if (values.includes(rule.equals))
					answers.push({ tenant: rule.tenantId, tags: rule.tags, aliases: [] });
			}
			return answers;
		},
	};
}

export function combineDirectories(
	directories: readonly PrincipalDirectory[],
): PrincipalDirectory {
	return {
		async tenantsOf(principal, claims) {
			const merged = new Map<
				TenantId,
				{ tags: Set<string>; aliases: Set<string> }
			>();
			for (const directory of directories) {
				for (const answer of await directory.tenantsOf(principal, claims)) {
					const entry = merged.get(answer.tenant) ?? {
						tags: new Set<string>(),
						aliases: new Set<string>(),
					};
					for (const tag of answer.tags) entry.tags.add(tag);
					for (const alias of answer.aliases) entry.aliases.add(alias);
					merged.set(answer.tenant, entry);
				}
			}
			return [...merged].map(([tenant, entry]) => ({
				tenant,
				tags: [...entry.tags].sort(),
				aliases: [...entry.aliases].sort(),
			}));
		},
	};
}
