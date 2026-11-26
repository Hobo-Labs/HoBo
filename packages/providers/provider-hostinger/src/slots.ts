/**
 * Typed Hostinger offering factories for Yard slot bindings.
 *
 * Why this module exists: authoring a slot binding by hand means typing a
 * capability-profile string, a product id, and an untyped property bag — three
 * independent chances to make a typo that only surfaces at resolution time.
 * Each factory here owns exactly one `(slot, profile, productId)` triple and
 * takes a per-product options interface, so the profile string is never typed
 * by an operator and a misspelled option name is a compile error.
 *
 * Every factory returns `slotBinding()` from `@hobo/core`; none of them build a
 * binding record by hand. The core parse boundary — credential screening,
 * JSON-safety, freezing, key ordering — therefore applies to every binding
 * produced here, and this module adds no parse rules of its own.
 *
 * No defaults are invented. A default plan or PHP version quietly deployed on
 * the caller's behalf would misreport what they asked for, so an omitted option
 * is simply absent from `properties` and the Resource Definition decides.
 *
 * HONEST SCOPE — the shape of this provider: Hostinger sells *hosting plans*,
 * not raw infrastructure primitives. The products below are the things a plan
 * gives you: a VPS you administer, shared/cloud web hosting that serves PHP, a
 * MySQL database that comes with the plan, and DNS for a domain you own. There
 * is no object store, no managed cache and no managed queue in this list
 * because Hostinger sells none, so the `bucket`, `kv`, `queue` and `topic`
 * slots stay empty rather than being filled with a near-miss.
 *
 * HONEST SCOPE — allocation is a purchase: every product here is allocated by
 * *buying a plan*, and the Hostinger API manages instances you already own
 * rather than ordering new ones. The resolvers in `./resolvers.ts` therefore
 * adopt-and-converge rather than create, and refuse the create path with
 * remediation instead of quietly placing a billing order. See that module.
 */
import { capability, type SlotBinding, slotBinding } from "@hobo/core";

export interface VpsOptions {
	readonly template?: string;
	readonly plan?: string;
	readonly hostname?: string;
	readonly backups?: boolean;
	readonly monitoring?: boolean;
}

export function vps(options?: VpsOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "hostinger.vps/v1",
		properties: present(options ?? {}),
	});
}

export function vpsWorker(options?: VpsOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "hostinger.vps/v1",
		properties: present(options ?? {}),
	});
}

export interface WebHostingOptions {
	readonly phpVersion?: string;
	readonly ssl?: boolean;
	readonly documentRoot?: string;
	readonly plan?: string;
}

export function webHosting(options?: WebHostingOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "hostinger.web-hosting/v1",
		properties: present(options ?? {}),
	});
}

export interface StaticSiteOptions {
	readonly indexDocument?: string;
	readonly errorDocument?: string;
	readonly documentRoot?: string;
}

export function staticSite(options?: StaticSiteOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.static,
		productId: "hostinger.static-site/v1",
		properties: present(options ?? {}),
	});
}

export interface MysqlOptions {
	readonly version?: string;
	readonly remoteAccess?: boolean;
	readonly charset?: string;
	readonly collation?: string;
}

export function mysql(options?: MysqlOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.mysql,
		productId: "hostinger.mysql/v1",
		properties: present(options ?? {}),
	});
}

export interface DnsZoneOptions {
	readonly ttl?: number;
	readonly wildcard?: boolean;
}

type AnySlotOptions =
	| VpsOptions
	| WebHostingOptions
	| StaticSiteOptions
	| MysqlOptions
	| DnsZoneOptions;

function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

export function dnsZone(options?: DnsZoneOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "hostinger.dns-zone/v1",
		properties: present(options ?? {}),
	});
}
