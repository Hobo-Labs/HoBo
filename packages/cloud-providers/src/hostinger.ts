/**
 * Hostinger: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything Hostinger *can* allocate — a catalog, not a
 * selection. Which offering a given resource gets is decided later, by ADR-0151
 * selection, against the requirements the app actually states.
 *
 * HONEST SCOPE — this provider works differently from the others here. On
 * Hostinger, allocation is a *purchase*: a VPS, a hosting plan and the MySQL
 * database that comes with it are obtained by placing a billing order, and the
 * API manages instances you already own. `@hobo/provider-hostinger`'s resolvers
 * therefore adopt-and-converge rather than create, and refuse with remediation
 * when there is nothing to adopt — a refusal its transport guard enforces by
 * not allowlisting the order-placing namespace at all. Resolver coverage is
 * `providerParity()` in `./parity.js`; `bucket`, `kv`, `queue`, `topic` and
 * `secretRef` carry no rows, because Hostinger sells none of them.
 */
import {
	type HostingerYardSpecOptions,
	hostingerYardSpec,
} from "@hobo/provider-hostinger";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	type DnsZoneOptions,
	dnsZone,
	type MysqlOptions,
	mysql,
	type StaticSiteOptions,
	staticSite,
	type VpsOptions,
	vps,
	vpsWorker,
	type WebHostingOptions,
	webHosting,
} from "@hobo/provider-hostinger";

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(hostinger, …).
export const PROVIDER_ID = "hostinger";

export const DEFAULT_HOSTINGER_YARD_NAME = "hostinger";

export interface HostingerYardOptions
	extends ComposedYardOptions,
		HostingerYardSpecOptions {}

export function Yard(options: HostingerYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_HOSTINGER_YARD_NAME,
		hostingerYardSpec(regionOption(options.regions)),
		options,
	);
}
