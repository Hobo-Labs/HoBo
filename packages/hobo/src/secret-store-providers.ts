import type { RegistrableProvider } from "@hobo/cloud";

// The owner's third-party secret stores as providers of the `secretRef` port:
// `hobo add infisical`, `hobo add bitwarden`, `hobo add 1password`.
//
// A secret store is another vendor's service, so it is its own provider and
// lands in a Yard of its own, joined to the workload's by a junction (a Yard
// holds nothing external). What it realizes for a `secretRef` resource is a
// reference, never a value: the store's id and the folder (Infisical), vault
// (1Password) or project (Bitwarden) the workload reads, which the deployment
// resolves at run time with its own sign-in. No value passes through the plan,
// the journal or a provider's realization.
//
// The composed deploy executor runs such a placement as a reference
// (`secret-ref-executor.ts`), across the provider junction that joins the
// reader's Yard to the store's.
//
// Both operations the SDK declares on a secret resource (`access`, `put`) are
// ones every store here serves. A store's sign-in and coordinates come from
// the owner's ceremony (`@hobo/hobo-ci` `ownerStore`), not from this
// catalog entry.

export const SECRET_STORE_PROVIDERS = Object.freeze({
	infisical: {
		label: "Infisical",
		reference: "infisical://<project>/<environment>/<folder>/<name>",
		workloadSignIn: "OIDC Auth (no secret to keep)",
	},
	bitwarden: {
		label: "Bitwarden Secrets Manager",
		reference: "bitwarden://<organization>/<project>/<name>",
		workloadSignIn: "a machine account token the platform keeps",
	},
	"1password": {
		label: "1Password",
		reference: "op://<vault>/<item>/value",
		workloadSignIn: "a service account token the platform keeps",
	},
} as const);

export type SecretStoreProviderId = keyof typeof SECRET_STORE_PROVIDERS;

/** The operations a `secretRef` request may ask for. */
const SECRET_OPERATIONS: readonly string[] = Object.freeze(["access", "put"]);

/** One secret store as a `secretRef` provider (see the module comment). */
export function createSecretStoreProvider(
	store: SecretStoreProviderId,
): RegistrableProvider {
	const id = `secret-store:${store}`;
	const facts = SECRET_STORE_PROVIDERS[store];
	return {
		id,
		regions: ["global"],
		capabilities: [
			{
				port: "secretRef",
				satisfies(request) {
					if (request.port !== "secretRef") return { kind: "none" };
					const missing = (request.features ?? []).filter(
						(feature) => !SECRET_OPERATIONS.includes(feature),
					);
					return missing.length === 0
						? { kind: "full" }
						: { kind: "partial", missing };
				},
				estimateCost: () => ({
					marginalPrice: "0",
					sku: `${id}:secret`,
					unit: "secret",
					pricingStatus: "unknown",
				}),
			},
		],
		capabilityManifest: () => ({
			providerId: id,
			published: {
				"/.well-known/capability-manifest/index.json": JSON.stringify({
					providerId: id,
					ports: ["secretRef"],
				}),
			},
			capabilities: {
				capabilities: [
					{
						port: "secretRef",
						features: [...SECRET_OPERATIONS],
						regions: ["global"],
						providerService: facts.label,
						realizes: "reference",
						reference: facts.reference,
						workloadSignIn: facts.workloadSignIn,
					},
				],
			},
			cost: {
				facts: [
					{
						port: "secretRef",
						sku: `${id}:secret`,
						unit: "secret",
						marginalPrice: "0",
					},
				],
			},
		}),
	};
}
