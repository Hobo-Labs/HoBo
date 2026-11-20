/**
 * Vercel: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns Vercel's default targets — four offerings. The full
 * allocatable catalog is five: the default plus the opt-in `project()` row,
 * reached with `Yard({ project: {} })`. Unlike Azure or GCP, most
 * Vercel slots hold exactly one entry — not because the catalog is abridged,
 * but because Vercel genuinely ships one product per capability. A single entry
 * here is an accurate catalog, not a selection made early.
 *
 * SCOPE: part of this catalog is backed by Vercel REST API drivers
 * (`VERCEL_RESOLVED_PRODUCT_IDS`); `vercel.edge-function/v1` has none,
 * for the reasons named in `VERCEL_UNRESOLVED_PRODUCT_IDS`. Native Blob
 * reconciliation requires an approved project, scoped credentials and a
 * durable mutation journal. The opt-in `project()` row is resolved but
 * absent from the bare `Yard()`, so `providerParity()` measures Vercel against
 * the full five-offering catalog, not the four-offering default. Those
 * drivers are proven against an injected fake transport; a live deploy
 * additionally needs real credentials and network egress, which no test here
 * supplies.
 */
import {
	type VercelYardSpecOptions,
	vercelYardSpec,
} from "@hobo/provider-vercel";
import type { Yard as ParsedYard } from "@hobo/yards";

import { type ComposedYardOptions, composeYard } from "./compose.js";

export {
	blob,
	edgeConfig,
	edgeFunction,
	project,
	staticDeployment,
	type VercelBlobSlotOptions,
	type VercelEdgeConfigSlotOptions,
	type VercelEdgeFunctionSlotOptions,
	type VercelProjectSlotOptions,
	type VercelStaticDeploySlotOptions,
} from "@hobo/provider-vercel";

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(vercel, …).
export const PROVIDER_ID = "vercel";

// public-contract: the name every default Vercel Yard is registered under; changing it renames them all.
export const DEFAULT_VERCEL_YARD_NAME = "vercel";

export interface VercelYardOptions
	extends ComposedYardOptions,
		VercelYardSpecOptions {}

export function Yard(options: VercelYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_VERCEL_YARD_NAME,
		vercelYardSpec(options),
		options,
	);
}
