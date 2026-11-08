/**
 * `@hobo/cloud-providers` — one import for every cloud's default Yard.
 *
 * The authoring shape this package exists to serve:
 *
 * ```ts
 * import { aws, azure, cloudflare } from "@hobo/cloud-providers";
 * import { defineStation } from "@hobo/yards";
 *
 * export default defineStation("acme", {
 *   yards: [aws.Yard(), azure.Yard(), cloudflare.Yard({ regions: ["weur"] })],
 * });
 * ```
 *
 * Each namespace exposes `Yard()` — the provider's default catalog, parsed
 * into a real `Yard`; for every namespace but Vercel that is its full
 * allocatable catalog (Vercel's bare `Yard()` omits the opt-in `project()`
 * row; see `src/vercel.ts`) — alongside that provider's slot factories, so
 * narrowing or re-parameterizing a catalog uses the same typed vocabulary the
 * default is built from:
 *
 * ```ts
 * import { defineYard } from "@hobo/yards";
 * import { azure } from "@hobo/cloud-providers";
 *
 * // Only the offerings this team is willing to run.
 * export const prod = defineYard("prod-eu", {
 *   provider: "azure",
 *   region: "westeurope",
 *   web: [azure.containerApps({ ingress: "external" }), azure.aks({ replicas: 3 })],
 *   data: azure.postgresFlexible({ tier: "GeneralPurpose" }),
 * });
 * ```
 *
 * A Yard is a **catalog, not an inventory** (ADR-0157 decision 1): its rows say
 * what the provider *is able to* allocate, so several entries per capability is
 * the normal case and declaring one allocates nothing. Selection among them
 * happens at resolution time under ADR-0151's hard gates and lexicographic
 * ranking — never here.
 *
 * HONEST SCOPE, per provider. No namespace here has registered Resource
 * Definitions for its product ids, so a deploy against any of these Yards
 * fails closed at resolution rather than half-applying; what differs is how
 * much of a real API each provider package can already talk to, and every one
 * of those is proven against an injected fake transport rather than a live
 * account.
 *
 * How much, per provider, is deliberately not written here. This header once
 * said `aws (7/19)` and `hostinger (2/5)` while the constants said 8 and 5:
 * prose counts drift the moment a resolver lands. Call `providerParity()` —
 * it derives `resolved/catalog` from each namespace's full allocatable
 * catalog (`PARITY_SOURCES`; Vercel's includes the opt-in `project()` row) and
 * the provider package's `*_RESOLVED_PRODUCT_IDS`, and `formatParityClaim()`
 * renders it with the denominator attached. Two qualitative facts stay true
 * regardless of counts:
 *   - **kubernetes** also has a placement driver (`provisionWorkload`) written
 *     to place onto a real cluster through an injected transport (opt-in
 *     `kubectl proxy`); that driver is not a resolver, no live apply is
 *     proven here, and the resolvers stay fake-transport only. Its catalog is built-ins only, because databases, caches and
 *     queues arrive through operators this package cannot see.
 *   - **hostinger** allocation is a *billing order*, so its resolvers adopt and
 *     converge what you already bought and refuse to purchase; its transport
 *     guard does not allowlist the order-placing namespace.
 */
export * as aws from "./aws.js";
export * as azure from "./azure.js";
export {
	BuilderError,
	type BuilderErrorCode,
	type CampBuilder,
	camp,
	type ProviderNamespaceRef,
	type ProviderRef,
	providerIdOf,
	type StationBuilder,
	type StationManifest,
	station,
	type YardBuilder,
	type YardSlotMethods,
	yard,
} from "./builders.js";
export * as cloudflare from "./cloudflare.js";

export {
	type CatalogRow,
	type ComposedYardOptions,
	composeYard,
	type YardSpecLike,
} from "./compose.js";
export * as digitalocean from "./digitalocean.js";
export * as gcp from "./gcp.js";
export * as hetzner from "./hetzner.js";
export * as hostinger from "./hostinger.js";
export * as kubernetes from "./kubernetes.js";
export {
	formatParityClaim,
	PARITY_LEVELS,
	PARITY_PROVIDERS,
	PARITY_SOURCES,
	ParityError,
	type ParityErrorCode,
	type ParityLevel,
	type ParityProvider,
	type ParitySource,
	type ProviderParityRecord,
	type ProviderParityRow,
	parityRow,
	providerParity,
	type SimulatedParityLevel,
	toProviderParityRecord,
} from "./parity.js";
export * as vercel from "./vercel.js";
