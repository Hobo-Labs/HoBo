/**
 * Cloudflare: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything Cloudflare *can* allocate — a catalog, not a
 * selection. Which offering a given resource gets is decided later, by ADR-0151
 * selection, against the requirements the app actually states.
 *
 * SCOPE: every product in this catalog has an HTTP deployment resolver
 * (`cloudflareResolverRegistry`; count in `providerParity()`), backed by
 * `api.cloudflare.com/client/v4` drivers. Those drivers are proven against an
 * injected fake transport; a live deploy additionally needs real credentials
 * and network egress, which no test here supplies.
 */
import {
	type CloudflareYardOptions as CloudflareCatalogOptions,
	cloudflareYardSpec,
} from "@hobo/provider-cloudflare";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	type D1Options,
	d1,
	type KvOptions,
	kv,
	type PagesOptions,
	pages,
	type QueuesOptions,
	queues,
	R2_JURISDICTIONS,
	type R2Jurisdiction,
	type R2Options,
	r2,
	type WorkersOptions,
	workers,
} from "@hobo/provider-cloudflare";

/**
 * This namespace's provider id, read when it is passed to `yard(cloudflare, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have
 * to guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(cloudflare, …).
export const PROVIDER_ID = "cloudflare";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default Cloudflare Yard is registered under; changing it renames them all.
export const DEFAULT_CLOUDFLARE_YARD_NAME = "cloudflare";

export interface CloudflareYardOptions
	extends ComposedYardOptions,
		Omit<CloudflareCatalogOptions, "name"> {}

/** The default Cloudflare Yard: the full allocatable catalog, canonicalized. */
export function Yard(options: CloudflareYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_CLOUDFLARE_YARD_NAME,
		cloudflareYardSpec(regionOption(options.regions)),
		options,
	);
}
