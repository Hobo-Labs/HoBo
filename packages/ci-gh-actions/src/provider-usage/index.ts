import { DEPOT_API_ORIGIN, DepotUsageReader } from "./depot.js";
import { NamespaceUsageReader, namespaceComputeOrigin } from "./namespace.js";
import {
	PROVIDER_USAGE_TIMEOUT_MS,
	type ProviderUsageReader,
} from "./reader.js";
import type { UsageSyncProvider } from "./subscription.js";
import { WARPBUILD_API_BASE, WarpbuildUsageReader } from "./warpbuild.js";

export {
	DEPOT_API_ORIGIN,
	DEPOT_USAGE_OBSERVED_AT,
	DEPOT_USAGE_PROCEDURE,
	DEPOT_USAGE_SOURCE,
	DepotUsageReader,
	type DepotUsageReaderDeps,
} from "./depot.js";
export {
	NAMESPACE_RATE_SOURCE,
	NAMESPACE_USAGE_OBSERVED_AT,
	NAMESPACE_USAGE_PROCEDURE,
	NAMESPACE_USAGE_SOURCE,
	NAMESPACE_USD_PER_UNIT_MINUTE,
	NamespaceUsageReader,
	type NamespaceUsageReaderDeps,
	namespaceComputeOrigin,
	namespacePeriod,
} from "./namespace.js";
export {
	PROVIDER_USAGE_TIMEOUT_MS,
	type ProviderUsageReader,
	type UsageHttpDeps,
	type UsageReadRequest,
	type UsageWindow,
} from "./reader.js";
export {
	type CredentialResolver,
	NAMESPACE_DEFAULT_REGION,
	type OwnerCredentialSource,
	ownerStoreCredentialResolver,
	PROVIDER_USAGE_CREDENTIAL_SCOPE,
	type ProviderUsageSubscription,
	type ProviderUsageSubscriptionInput,
	parseProviderUsageSubscription,
	USAGE_SYNC_PROVIDERS,
	type UsageSyncProvider,
} from "./subscription.js";
export {
	PROVIDER_USAGE_MAX_AGE_MS,
	PROVIDER_USAGE_SYNC_INTERVAL_MS,
	type ProviderUsageReading,
	ProviderUsageSync,
	type ProviderUsageSyncDeps,
	type ProviderUsageSyncOutcome,
	SyncedSpendReader,
	type SyncedSpendReaderDeps,
	type SyncTimers,
	scheduleProviderUsageSync,
} from "./sync.js";
export {
	WARPBUILD_API_BASE,
	WARPBUILD_USAGE_OBSERVED_AT,
	WARPBUILD_USAGE_PATH,
	WARPBUILD_USAGE_SOURCE,
	WarpbuildUsageReader,
	type WarpbuildUsageReaderDeps,
} from "./warpbuild.js";

export function providerUsageReaders(
	fetchImpl: typeof fetch,
): ReadonlyMap<UsageSyncProvider, ProviderUsageReader> {
	const http = { fetch: fetchImpl, timeoutMs: PROVIDER_USAGE_TIMEOUT_MS };
	return new Map<UsageSyncProvider, ProviderUsageReader>([
		["depot", new DepotUsageReader({ ...http, baseUrl: DEPOT_API_ORIGIN })],
		[
			"namespace",
			new NamespaceUsageReader({ ...http, originOf: namespaceComputeOrigin }),
		],
		[
			"warpbuild",
			new WarpbuildUsageReader({ ...http, baseUrl: WARPBUILD_API_BASE }),
		],
	]);
}
