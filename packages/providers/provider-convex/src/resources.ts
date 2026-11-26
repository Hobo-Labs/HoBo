/**
 * Operator SDK resource definitions for Convex (custom adapter authoring).
 * Uses @hobo/sdk `defineResource` so Matching catalogs the same records
 * provider packages publish — not a second definition shape.
 */
import { defineResource } from "@hobo/sdk";

import { CONVEX_PROVIDER_ID } from "./manifest.js";

/** Reactive document database port realized on Convex (Cloud or self-host). */
export const convexReactiveDatabase = defineResource({
	type: "database",
	engine: "document",
	class: "reactive",
	features: ["search.vector", "functions.scheduled"],
	with: {
		providerId: CONVEX_PROVIDER_ID,
		definitionId: `${CONVEX_PROVIDER_ID}.database.reactive`,
		regions: ["us", "eu"],
		cost: {
			sku: "convex.db.gb-month",
			unit: "gb-month",
			marginalPrice: "0",
		},
		properties: {
			paradigm: "document",
			driver: "convex-deploy",
			selfHostEnv: ["CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"],
			cloudEnv: ["CONVEX_DEPLOY_KEY"],
		},
	},
	match: {
		paradigm: "document",
		reactivity: "live-query",
	},
});

/** Compute / HTTP actions on a Convex deployment. */
export const convexWebService = defineResource({
	type: "compute",
	class: "function-host",
	with: {
		providerId: CONVEX_PROVIDER_ID,
		definitionId: `${CONVEX_PROVIDER_ID}.compute.function-host`,
		regions: ["us", "eu"],
		properties: {
			driver: "convex-deploy",
		},
	},
	match: {
		runtime: "typescript",
	},
});

export const CONVEX_SDK_RESOURCES = Object.freeze([
	convexReactiveDatabase,
	convexWebService,
]);
