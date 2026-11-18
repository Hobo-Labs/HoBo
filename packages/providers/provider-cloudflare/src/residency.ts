import { jurisdictionsForRegion, type JurisdictionId } from "@hobo/core";

import type { R2Jurisdiction } from "./slots.js";

const CLOUDFLARE_RESIDENCY_EVIDENCE_SCHEMA =
	"hobo.provider-residency-evidence/v1";

export const CLOUDFLARE_R2_RESIDENCY_REGIONS = Object.freeze({
	eu: "cloudflare-r2-eu",
	fedramp: "cloudflare-r2-fedramp",
} as const satisfies Record<R2Jurisdiction, string>);

export interface CloudflareR2ResidencyEvidence {
	readonly schema: typeof CLOUDFLARE_RESIDENCY_EVIDENCE_SCHEMA;
	readonly providerId: "cloudflare";
	readonly productId: "cloudflare.r2/v1";
	readonly control: "cf-r2-jurisdiction";
	readonly region: (typeof CLOUDFLARE_R2_RESIDENCY_REGIONS)[R2Jurisdiction];
	readonly jurisdictions: readonly JurisdictionId[];
	readonly verified: true;
	readonly verification: Readonly<{
		method: "successful-scoped-api-request";
		header: "cf-r2-jurisdiction";
		value: R2Jurisdiction;
	}>;
}

export function cloudflareR2ResidencyEvidence(
	jurisdiction: string,
): CloudflareR2ResidencyEvidence {
	if (!isR2Jurisdiction(jurisdiction)) {
		throw new TypeError(
			`Unsupported Cloudflare R2 jurisdiction: ${jurisdiction}`,
		);
	}
	const region = CLOUDFLARE_R2_RESIDENCY_REGIONS[jurisdiction];
	const jurisdictions = jurisdictionsForRegion(region);
	if (jurisdictions.length === 0) {
		throw new TypeError(
			`Cloudflare R2 residency region is unmapped: ${region}`,
		);
	}
	return Object.freeze({
		schema: CLOUDFLARE_RESIDENCY_EVIDENCE_SCHEMA,
		providerId: "cloudflare",
		productId: "cloudflare.r2/v1",
		control: "cf-r2-jurisdiction",
		region,
		jurisdictions: Object.freeze([...jurisdictions]),
		verified: true,
		verification: Object.freeze({
			method: "successful-scoped-api-request",
			header: "cf-r2-jurisdiction",
			value: jurisdiction,
		}),
	});
}

export function isR2Jurisdiction(value: string): value is R2Jurisdiction {
	return value === "eu" || value === "fedramp";
}
