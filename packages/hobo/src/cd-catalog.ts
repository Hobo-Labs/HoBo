/**
 * Out-of-tree platforms in the hosting catalog (WP18, plan 0024, D6/C12).
 *
 * Verified `hobo:resolver` WASM components (`@hobo/resolver-components`)
 * become `ResourceResolver`s through `componentResolvers`, and enter the
 * production hosting catalog only through its `extraResolvers` seam: a
 * component can add a platform, never shadow a shipped resolver (the catalog
 * refuses that). Loading and verifying the signed bundles is the resolver
 * component host's job (`loadResolverComponent`); this composes what it loaded.
 */

// binds at merge (plan 0024): componentResolvers is WP8.
import {
	componentResolvers,
	type LoadedResolverComponent,
} from "@hobo/resolver-components";
import {
	createProductionHostingProviderCatalog,
	type HostingProviderCatalogEntry,
} from "./provider-hosting-catalog.js";

export function createCdHostingCatalog(
	entries: readonly HostingProviderCatalogEntry[],
	components: readonly LoadedResolverComponent[] = [],
): ReturnType<typeof createProductionHostingProviderCatalog> {
	const extraResolvers = componentResolvers({ components });
	// binds at merge (plan 0024): the extraResolvers option is WP14's.
	return createProductionHostingProviderCatalog(entries, { extraResolvers });
}
