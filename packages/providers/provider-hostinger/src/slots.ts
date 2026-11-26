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
	/** An OS template name such as `ubuntu-24-04`. */
	readonly template?: string;
	/** A plan name such as `kvm1`; Hostinger bills the plan, not the shape. */
	readonly plan?: string;
	readonly hostname?: string;
	readonly backups?: boolean;
	readonly monitoring?: boolean;
}

/**
 * Hostinger VPS — slot `web`, profile `web.hosted/v1`. A KVM virtual machine
 * with a public address is Hostinger's most capable web lane; nothing above it
 * is a container platform, and this row does not pretend otherwise.
 */
export function vps(options?: VpsOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "hostinger.vps/v1",
		properties: present(options ?? {}),
	});
}

/**
 * The same VPS product reached through the `service` slot as a long-running
 * worker — slot `service`, profile `service.worker/v1`. Rows key on
 * `(profile, productId)`, so both coexist without colliding, and a workload
 * that needs a worker rather than a public origin matches only this one.
 */
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
	/** A plan name such as `premium` or `business`. */
	readonly plan?: string;
}

/**
 * Hostinger shared/cloud web hosting — slot `web`, profile `web.hosted/v1`. It
 * serves a PHP application on a managed origin, which is the same capability
 * profile a VPS satisfies through very different means; both are declared and
 * selection picks.
 */
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

/**
 * Prebuilt assets on a hosting plan — slot `web`, profile `web.static/v1`. A
 * static site is a narrower profile than `web.hosted/v1`, so this sits beside
 * the hosted options rather than competing with them, and a workload that only
 * needs assets can match the cheaper row.
 */
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

/**
 * Hostinger managed MySQL — slot `data`, profile `data.mysql/v1`. The database
 * is included with a hosting plan rather than billed as its own product, which
 * is why its declared marginal cost is a genuine zero.
 */
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

/**
 * Forwards the caller's option bag to the parse boundary, dropping only keys
 * whose value is `undefined` (an omitted option must be absent, not an
 * explicit `undefined`, under `exactOptionalPropertyTypes` and JSON-safety).
 *
 * Every remaining key is passed through — including one the option types do
 * not declare — so a key smuggled past the types reaches `slotBinding()` and
 * is screened there. Cherry-picking the known keys instead would silently
 * swallow it, which is exactly the kind of quiet drop this repo refuses.
 */
function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

/**
 * A Hostinger-hosted DNS zone — slot `api`, profile `api.http/v1`. A zone is
 * how an HTTP surface on this provider becomes addressable; there is no load
 * balancer product to name here, and pretending there is one would be the
 * portability lie this catalog avoids.
 */
export function dnsZone(options?: DnsZoneOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "hostinger.dns-zone/v1",
		properties: present(options ?? {}),
	});
}
