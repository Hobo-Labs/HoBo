import { createHash } from "node:crypto";

export function commercialProductRefsHash(
	refs: readonly string[],
): `sha256:${string}` {
	const normalized = [...refs].sort();
	const digest = createHash("sha256")
		.update(JSON.stringify(normalized))
		.digest("hex");
	return `sha256:${digest}`;
}

export function pricingCatalogHashFromCommercialRefs(
	refs: readonly string[],
): `sha256:${string}` {
	return commercialProductRefsHash(refs);
}

export function capabilityCatalogHashFromCommercialRefs(
	refs: readonly string[],
	capabilitySuffix = "",
): `sha256:${string}` {
	const digest = createHash("sha256")
		.update(JSON.stringify({ refs: [...refs].sort(), capabilitySuffix }))
		.digest("hex");
	return `sha256:${digest}`;
}
