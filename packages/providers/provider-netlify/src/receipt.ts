/**
 * The receipt projection, plus the scanner that keeps it honest.
 *
 * A receipt is the most-copied artifact this package produces: it lands in
 * logs, in a PR comment, in a support ticket, in an agent's context window. So
 * the projection is built by *listing what may appear* rather than by removing
 * what may not — a record gains fields over time, and a denylist silently starts
 * leaking the day someone adds one.
 */
import { redactSecretRef } from "@hobo/bindings";
import {
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
} from "@hobo/core/provider-redaction";

import type {
	AnonymousSiteRecord,
	SiteOwnershipVerification,
} from "./anonymous-site.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";
import { NetlifyProviderError } from "./provider-errors.js";

export type AnonymousSiteReceipt = {
	readonly schemaVersion: "hobo.receipt.netlify.anonymous-site/v1";
	readonly definitionId: string;
	readonly providerId: string;
	readonly deploymentRef: string;
	readonly siteId: string;
	readonly siteName: string;
	readonly siteUrl: string;
	/** A redacted locator, never the claim URL and never a bare reference. */
	readonly claimActionCustody: string;
	readonly claimActionId: string;
	readonly claimDeadlineMs: number;
	readonly expirySource: string;
	readonly sponsorExposureMinorUnits: number;
	readonly cliPackageSpec: string;
	readonly anonymousAuthorityRevoked: boolean;
	readonly claimStatus: string;
	readonly ownershipSignals: readonly {
		readonly id: string;
		readonly passed: boolean;
		readonly independent: boolean;
	}[];
	readonly reasons: readonly string[];
};

export function toAnonymousSiteReceipt(input: {
	readonly record: AnonymousSiteRecord;
	readonly verification?: SiteOwnershipVerification;
}): AnonymousSiteReceipt {
	const { record, verification } = input;
	return {
		schemaVersion: "hobo.receipt.netlify.anonymous-site/v1",
		definitionId: record.definitionId,
		providerId: record.providerId,
		deploymentRef: record.deploymentRef,
		siteId: record.siteId,
		siteName: record.siteName,
		siteUrl: record.siteUrl,
		claimActionCustody: redactSecretRef(record.claimUrlRef),
		claimActionId: record.claimActionId,
		claimDeadlineMs: record.claimDeadlineMs,
		expirySource: record.expirySource,
		sponsorExposureMinorUnits: record.sponsorExposureMinorUnits,
		cliPackageSpec: record.cliPackageSpec,
		anonymousAuthorityRevoked: record.anonymousAuthorityRevoked,
		claimStatus:
			verification === undefined
				? "unverified"
				: verification.verified
					? "verified"
					: verification.transferred
						? "transferred-unverified"
						: "not-transferred",
		ownershipSignals:
			verification?.signals.map((signal) => ({
				id: signal.id,
				passed: signal.passed,
				independent: signal.independent,
			})) ?? [],
		reasons: verification?.reasons ?? [],
	};
}

export type CredentialScanHit = {
	readonly label: string;
	readonly path: string;
};

/** Patterns that must never appear in anything this package serializes. */
const CREDENTIAL_PATTERNS: readonly {
	readonly label: string;
	readonly pattern: RegExp;
}[] = [
	{
		label: "claim or drop url with parameters",
		// The first `http(s)://` in a run, the first `claim`/`drop` after it, and
		// the first `?`/`#` after that: each part stops at its first occurrence,
		// so the search is linear where `\S*` before each part was not.
		pattern:
			/(?<!\S)(?:(?!https?:\/\/)\S)*https?:\/\/(?:(?!claim|drop)\S)*(?:claim|drop)[^\s?#]*[?#]\S/iu,
	},
	{
		label: "netlify session or site parameter",
		pattern: /\b(?:session_id|nf_jwt)=/iu,
	},
	{ label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/iu },
	{
		label: "netlify personal access token",
		pattern: /\bnfp_[A-Za-z0-9_-]{8,}/u,
	},
	{
		label: "netlify auth token assignment",
		pattern: /NETLIFY_(?:AUTH_)?TOKEN\s*[=:]\s*\S/iu,
	},
	{
		label: "connection string",
		pattern: /\b(?:postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?):\/\//iu,
	},
	{
		label: "api key assignment",
		pattern: /\bapi[_-]?key\s*[=:]\s*[^"\s,}]+/iu,
	},
	{
		label: "password assignment",
		pattern: /\b(?:password|passwd|pwd)\s*[=:]\s*[^"\s,}]+/iu,
	},
	{ label: "jwt", pattern: JWT_DETECTOR },
	{ label: "private key", pattern: PRIVATE_KEY_DETECTOR },
];

/**
 * Walk a JSON value and report credential-shaped strings with the path that
 * carried them, so a failure names the field rather than the haystack.
 */
export function scanForCredentialMaterial(
	value: JsonValue,
): readonly CredentialScanHit[] {
	const hits: CredentialScanHit[] = [];
	const seen = new WeakSet<object>();

	const walk = (node: JsonValue, path: string): void => {
		if (isJsonString(node)) {
			for (const pattern of CREDENTIAL_PATTERNS) {
				if (pattern.pattern.test(node)) {
					hits.push({ label: pattern.label, path });
				}
			}
			return;
		}
		if (node !== null && (isJsonArray(node) || isJsonObject(node))) {
			if (seen.has(node)) return;
			seen.add(node);
			const toJSON = "toJSON" in node ? node.toJSON : undefined;
			if (toJSON instanceof Function) {
				// SAFETY: custom serialization is an I/O boundary; scan its wire view.
				walk(toJSON.call(node) as JsonValue, path);
				return;
			}
		}
		if (isJsonArray(node)) {
			node.forEach((entry, index) => {
				walk(entry, `${path}[${index}]`);
			});
			return;
		}
		if (!isJsonObject(node)) return;
		for (const [key, entry] of Object.entries(node)) {
			walk(entry, path === "" ? key : `${path}.${key}`);
		}
	};

	walk(value, "");
	return hits;
}

export function assertNoCredentialMaterial(
	value: JsonValue,
	label: string,
): void {
	const hits = scanForCredentialMaterial(value);
	if (hits.length === 0) return;
	throw new NetlifyProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`${label} carries credential-shaped material at ${hits.map((hit) => hit.path).join(", ")}`,
		{ detail: { label, hits: hits.length } },
	);
}
