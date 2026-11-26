/**
 * Hetzner: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything Hetzner *can* allocate — a catalog, not a
 * selection. Which offering a given resource gets is decided later, by ADR-0151
 * selection, against the requirements the app actually states.
 *
 * HONEST SCOPE: this is the narrowest catalog in the package, and deliberately
 * so. Hetzner sells virtual machines, networking and storage; it sells no
 * managed database, cache, queue, topic or secret store, so five slots carry no
 * rows and an app that needs Postgres gets a truthful `none` here rather than a
 * machine it would have to administer. `@hobo/provider-hetzner` ships resolvers
 * for its catalogued products (count: `providerParity()` in `./parity.js`), each on
 * an exact-host transport guard and exercised against an injected fake
 * transport. No Resource Definitions are registered, so a deploy against this
 * Yard still fails closed at resolution.
 */
import {
	type HetznerYardSpecOptions,
	hetznerYardSpec,
} from "@hobo/provider-hetzner";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	type CloudServerOptions,
	cloudServer,
	cloudServerWorker,
	LOAD_BALANCER_ALGORITHMS,
	type LoadBalancerAlgorithm,
	type LoadBalancerOptions,
	loadBalancer,
	OBJECT_STORAGE_ACLS,
	type ObjectStorageAcl,
	type ObjectStorageOptions,
	objectStorage,
	SERVER_ARCHITECTURES,
	type ServerArchitecture,
	type StorageBoxOptions,
	storageBox,
	type VolumeOptions,
	volume,
} from "@hobo/provider-hetzner";

/**
 * This namespace's provider id, read when it is passed to `yard(hetzner, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have to
 * guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(hetzner, …).
export const PROVIDER_ID = "hetzner";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default Hetzner Yard is registered under; changing it renames them all.
export const DEFAULT_HETZNER_YARD_NAME = "hetzner";

export interface HetznerYardOptions
	extends ComposedYardOptions,
		HetznerYardSpecOptions {}

/** The default Hetzner Yard: the full allocatable catalog, parsed and canonical. */
export function Yard(options: HetznerYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_HETZNER_YARD_NAME,
		hetznerYardSpec(regionOption(options.regions)),
		options,
	);
}
