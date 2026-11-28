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
	return createProductionHostingProviderCatalog(entries, { extraResolvers });
}
