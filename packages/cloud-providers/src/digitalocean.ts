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

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(digitalocean, …).
export const PROVIDER_ID = "digitalocean";

export const DEFAULT_DIGITALOCEAN_YARD_NAME = "digitalocean";

export interface DigitalOceanYardOptions
	extends ComposedYardOptions,
		DigitalOceanYardSpecOptions {}

export function Yard(options: DigitalOceanYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_DIGITALOCEAN_YARD_NAME,
		digitaloceanYardSpec(regionOption(options.regions)),
		options,
	);
}
