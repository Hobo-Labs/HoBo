import type { YardBinding } from "./binding.js";

/** Connectivity a provider uses for services it runs on our behalf. */
export function providerManagedConnectivity(providerId: string): string {
	return `${providerKey(providerId)}.marketplace/v1`;
}

/** `@hobo/provider-vercel` and `vercel` name the same vendor. */
export function providerKey(providerId: string): string {
	return providerId.replace(/^@hobo\/provider-/u, "");
}

/** The vendor a product id belongs to: `upstash.redis/v1` → `upstash`, `local:sqlite-file` → `local`. */
export function productVendor(productId: string): string {
	return productId.split(/[.:]/u)[0] ?? productId;
}

export interface YardBoundaryViolation {
	readonly profile: string;
	readonly productId: string;
	readonly vendor: string;
	readonly message: string;
	readonly remediation: string;
}

/** Bindings a Yard would hold across its provider boundary. */
export function yardBoundaryViolations(
	yardName: string,
	providerId: string,
	bindings: readonly Pick<
		YardBinding,
		"profile" | "productId" | "connectivityId"
	>[],
): YardBoundaryViolation[] {
	const provider = providerKey(providerId);
	const managed = providerManagedConnectivity(providerId);
	return bindings.flatMap((binding) => {
		if (binding.productId === undefined) return [];
		const vendor = productVendor(binding.productId);
		if (vendor === provider) return [];
		if (binding.connectivityId === managed) return [];
		return [
			{
				profile: binding.profile,
				productId: binding.productId,
				vendor,
				message: `Yard ${yardName} (provider ${provider}) holds ${binding.productId}, which ${vendor} runs, not ${provider}`,
				remediation: `Declare ${binding.productId} in a Yard whose provider is ${vendor} and join the two Yards with a junction; or, if ${provider} provisions and runs it for you, attach it with connectivityId ${managed}.`,
			},
		];
	});
}

export class YardBoundaryError extends Error {
	readonly code = "YARD_EXTERNAL_FORBIDDEN" as const;
	readonly violations: readonly YardBoundaryViolation[];

	constructor(violations: readonly YardBoundaryViolation[]) {
		super(
			`${violations.map((v) => v.message).join("; ")}. ${violations[0]?.remediation ?? ""}`,
		);
		this.name = "YardBoundaryError";
		this.violations = violations;
	}
}
