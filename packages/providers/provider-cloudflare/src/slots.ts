/**
 * Typed Cloudflare offering factories for Yard slot bindings.
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
 * No defaults are invented. A setting silently chosen on the caller's behalf
 * would misreport what they asked for, so an omitted option is simply absent
 * from `properties` and the Resource Definition decides.
 *
 * HONEST SCOPE: the `productId` values below are the ids these factories
 * *emit*. Whether a matching Resource Definition is registered in the catalog
 * is checked at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here — a
 * successful call is not evidence that the product exists in the catalog
 * today, and several of these products are not registered yet.
 */
import { capability, type SlotBinding, slotBinding } from "@hobo/core";

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
type AnySlotOptions =
	| R2Options
	| D1Options
	| KvOptions
	| QueuesOptions
	| WorkersOptions
	| PagesOptions;

function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

/** R2 jurisdictions that restrict where objects may be stored. */
export const R2_JURISDICTIONS = Object.freeze(["eu", "fedramp"] as const);

export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

export interface R2Options {
	readonly publicBucket?: boolean;
	readonly jurisdiction?: R2Jurisdiction;
}

/** Cloudflare R2 bucket — slot `bucket`, profile `bucket.s3-compatible/v1`. */
export function r2(options?: R2Options): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.s3Compatible,
		productId: "cloudflare.r2/v1",
		properties: present(options ?? {}),
	});
}

export interface D1Options {
	readonly readReplication?: boolean;
}

/** Cloudflare D1 database — slot `data`, profile `data.sqlite/v1`. */
export function d1(options?: D1Options): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.sqlite,
		productId: "cloudflare.d1/v1",
		properties: present(options ?? {}),
	});
}

export interface KvOptions {
	readonly ttlSeconds?: number;
}

/** Cloudflare Workers KV namespace — slot `kv`, profile `kv.key-value/v1`. */
export function kv(options?: KvOptions): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.keyValue,
		productId: "cloudflare.kv/v1",
		properties: present(options ?? {}),
	});
}

export interface QueuesOptions {
	readonly maxBatchSize?: number;
	readonly maxRetries?: number;
}

/** Cloudflare Queues queue — slot `queue`, profile `queue.at-least-once/v1`. */
export function queues(options?: QueuesOptions): SlotBinding {
	return slotBinding({
		slot: "queue",
		profile: capability.queue.atLeastOnce,
		productId: "cloudflare.queues/v1",
		properties: present(options ?? {}),
	});
}

export interface WorkersOptions {
	/** Explicit public workers.dev exposure; absent preserves the observed setting. */
	readonly workersDev?: boolean;
	readonly compatibilityDate?: string;
	readonly smartPlacement?: boolean;
}

/** Cloudflare Worker — slot `service`, profile `service.worker/v1`. */
export function workers(options?: WorkersOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "cloudflare.workers/v1",
		properties: present(options ?? {}),
	});
}

export interface PagesOptions {
	readonly productionBranch?: string;
}

/** Cloudflare Pages project — slot `web`, profile `web.hosted/v1`. */
export function pages(options?: PagesOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "cloudflare.pages/v1",
		properties: present(options ?? {}),
	});
}
