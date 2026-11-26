/**
 * DigitalOcean: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything DigitalOcean *can* allocate — a catalog, not a
 * selection. Which offering a given resource gets is decided later, by ADR-0151
 * selection, against the requirements the app actually states.
 *
 * HONEST SCOPE: `@hobo/provider-digitalocean` ships resolvers for its
 * catalogued products (count: `providerParity()` in `./parity.js`), exercised against an
 * injected fake transport, and registers no Resource Definitions for the
 * `digitalocean.*` product ids — so a deploy against this Yard still fails
 * closed at resolution until definitions land.
 * `queue`, `topic` and `secretRef` carry no rows at all, because DigitalOcean
 * sells no first-party queue and no first-party secret store.
 */
import {
	type DigitalOceanYardSpecOptions,
	digitaloceanYardSpec,
} from "@hobo/provider-digitalocean";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	APP_PLATFORM_INGRESS,
	type AppPlatformIngress,
	type AppPlatformJobOptions,
	type AppPlatformServiceOptions,
	type AppPlatformStaticSiteOptions,
	type AppPlatformWorkerOptions,
	appPlatform,
	type BlockStorageOptions,
	blockStorage,
	type DropletOptions,
	droplet,
	dropletWorker,
	type FunctionsOptions,
	functions,
	type KubernetesNodePoolOptions,
	kubernetesCluster,
	LOAD_BALANCER_ALGORITHMS,
	type LoadBalancerAlgorithm,
	type LoadBalancerOptions,
	loadBalancer,
	type ManagedDatabaseOptions,
	managed,
	managedValkey,
	SPACES_ACLS,
	type SpacesAcl,
	type SpacesOptions,
	spaces,
} from "@hobo/provider-digitalocean";

/**
 * This namespace's provider id, read when it is passed to
 * `yard(digitalocean, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have to
 * guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(digitalocean, …).
export const PROVIDER_ID = "digitalocean";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default DigitalOcean Yard is registered under; changing it renames them all.
export const DEFAULT_DIGITALOCEAN_YARD_NAME = "digitalocean";

export interface DigitalOceanYardOptions
	extends ComposedYardOptions,
		DigitalOceanYardSpecOptions {}

/**
 * The default DigitalOcean Yard: the full allocatable catalog, parsed and
 * canonical.
 */
export function Yard(options: DigitalOceanYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_DIGITALOCEAN_YARD_NAME,
		digitaloceanYardSpec(regionOption(options.regions)),
		options,
	);
}
