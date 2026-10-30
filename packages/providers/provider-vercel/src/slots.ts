/**
 * Typed slot factories for the Vercel Yard catalog (ADR-0157).
 *
 * A Yard declares what **can** be allocated on a provider — not what an app
 * uses, not a mapping, not a pool. These factories are the authoring surface
 * for that catalog: each one names one Vercel offering and returns the
 * `SlotBinding` record `@hobo/yards` compiles into a binding row. A slot may
 * carry several offerings; picking among them is selection's job, later, and
 * nothing here ranks or chooses.
 *
 * Why factories rather than hand-typed rows: a row is magic strings
 * (`{ profile: capability.web.hosted, productId: "vercel.project/v1" }`) with no
 * autocomplete and no type checking on the property bag. Each factory below has
 * its **own** options type — never `Record<string, unknown>` in the signature —
 * so a typo is a compile error rather than a deploy-time surprise.
 *
 * Every factory returns `slotBinding({…})` from `@hobo/core` rather than an
 * object literal, so core's parse boundary is the only way in: credential-shaped
 * property keys are refused, values must be JSON-safe, keys are sorted, and the
 * record comes back deep-frozen. The caller's whole option bag is forwarded
 * (minus `undefined` values, which read as absent) precisely so an undeclared
 * key reaches that screen instead of being silently dropped — a dropped key is
 * how a secret ends up believed-rejected and actually ignored.
 *
 * No defaults are invented for provider settings. Absent means absent: the
 * Resource Definition decides what an unset `framework` or `access` means, not
 * this catalog. Pure and deterministic — no clock, no randomness, no ambient
 * environment reads.
 */

import { type SlotBinding, slotBinding } from "@hobo/core";
import { VERCEL_STATIC_DEPLOY_PRODUCT_ID } from "./deployment-resolver.js";

// public-contract: product ids the Vercel catalog registers for these offerings.
export const VERCEL_PROJECT_PRODUCT_ID = "vercel.project/v1";
// public-contract: product id the Yard catalog and the resolver registry are both keyed by; they must not drift.
export const VERCEL_EDGE_FUNCTION_PRODUCT_ID = "vercel.edge-function/v1";
// public-contract: product id the Yard catalog and the resolver registry are both keyed by; they must not drift.
export const VERCEL_BLOB_PRODUCT_ID = "vercel.blob/v1";
// public-contract: product id the Yard catalog and the resolver registry are both keyed by; they must not drift.
export const VERCEL_EDGE_CONFIG_PRODUCT_ID = "vercel.edge-config/v1";

// public-contract: capability profiles these offerings claim to satisfy.
export const VERCEL_PROJECT_PROFILE = "provider.project/v1";
export const VERCEL_STATIC_DEPLOY_PROFILE = "web.hosted/v1";
export type VercelStaticDeploySlotOptions = { readonly projectId?: string };
export function staticDeployment(
	options: VercelStaticDeploySlotOptions = {},
): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: VERCEL_STATIC_DEPLOY_PROFILE,
		productId: VERCEL_STATIC_DEPLOY_PRODUCT_ID,
		properties: definedProperties(options),
	});
}
// public-contract: capability profile this offering satisfies; changing it re-targets the slot.
export const VERCEL_EDGE_FUNCTION_PROFILE = "service.worker/v1";
// public-contract: capability profile this offering satisfies; changing it re-targets the slot.
export const VERCEL_BLOB_PROFILE = "bucket.object/v1";
// public-contract: capability profile this offering satisfies; changing it re-targets the slot.
export const VERCEL_EDGE_CONFIG_PROFILE = "kv.key-value/v1";

/** Vercel project settings, as documented on `POST /v9/projects`. */
export type VercelProjectSlotOptions = {
	readonly framework?: string;
	readonly rootDirectory?: string;
	readonly buildCommand?: string;
	readonly outputDirectory?: string;
};

/** Edge/serverless function settings carried on a `service` slot. */
export type VercelEdgeFunctionSlotOptions = {
	readonly memoryMb?: number;
	readonly maxDuration?: number;
	readonly regions?: readonly string[];
};

/** Blob store settings. `access` mirrors the documented store access level. */
export type VercelBlobSlotOptions = {
	readonly access?: "public" | "private";
};

/** Edge Config (now the Global Config REST family) settings. */
export type VercelEdgeConfigSlotOptions = {
	readonly itemCountLimit?: number;
};

/**
 * Drop `undefined` values, keep every other key.
 *
 * Keeping unknown keys is deliberate: they are forwarded into
 * `slotBinding()` so core screens them. Filtering to a known allowlist here
 * would silently swallow a `apiKey` someone passed by mistake, and a silently
 * swallowed credential is worse than a refusal.
 */
type AnySlotOptions =
	| VercelProjectSlotOptions
	| VercelStaticDeploySlotOptions
	| VercelEdgeFunctionSlotOptions
	| VercelBlobSlotOptions
	| VercelEdgeConfigSlotOptions;

function definedProperties(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

/** A Vercel Project: the `web` slot, satisfying `web.hosted/v1`. */
export function project(options: VercelProjectSlotOptions = {}): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: VERCEL_PROJECT_PROFILE,
		productId: VERCEL_PROJECT_PRODUCT_ID,
		properties: definedProperties(options),
	});
}

/** A Vercel Edge Function: the `service` slot, satisfying `service.worker/v1`. */
export function edgeFunction(
	options: VercelEdgeFunctionSlotOptions = {},
): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: VERCEL_EDGE_FUNCTION_PROFILE,
		productId: VERCEL_EDGE_FUNCTION_PRODUCT_ID,
		properties: definedProperties(options),
	});
}

/** A Vercel Blob store: the `bucket` slot, satisfying `bucket.object/v1`. */
export function blob(options: VercelBlobSlotOptions = {}): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: VERCEL_BLOB_PROFILE,
		productId: VERCEL_BLOB_PRODUCT_ID,
		properties: definedProperties(options),
	});
}

/** A Vercel Edge Config: the `kv` slot, satisfying `kv.key-value/v1`. */
export function edgeConfig(
	options: VercelEdgeConfigSlotOptions = {},
): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: VERCEL_EDGE_CONFIG_PROFILE,
		productId: VERCEL_EDGE_CONFIG_PRODUCT_ID,
		properties: definedProperties(options),
	});
}

/**
 * The factories as one frozen group, for callers that would rather not import
 * four bare names into their module scope.
 */
export const vercelSlots = Object.freeze({
	staticDeployment,
	blob,
	edgeConfig,
	edgeFunction,
	project,
});
