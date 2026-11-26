import type { ResourceIntent } from "../../src/index.js";

/**
 * Every `ResourceIntent` value that exists in this repository today.
 *
 * These are transcribed, not invented. A schema exercised only against values
 * its own author wrote passes its own test and fails on real data, so each
 * entry below names the file it came from and an `anchor` — the distinguishing
 * fragment of the original source. `provenance.test.ts` reads each cited file
 * from disk and fails if its anchor is no longer there, which is what stops the
 * transcription from quietly drifting away from the thing it claims to mirror.
 *
 * Anchors are compared with all whitespace removed, so reformatting the cited
 * file does not break them; changing the value does.
 *
 * Three sources contribute:
 *
 *  - `packages/cloud/test/placement.test.ts` builds intents through `kvIntent()`
 *    and `criteria()` helpers. The transcribed value is the helper's output,
 *    i.e. the defaults merged with the overrides at that call site.
 *  - `packages/cloud/test/registry.test.ts` and
 *    `packages/cloud/contracts/consumer/control-plane-boundaries.test.ts` write
 *    the literals out in full.
 *  - `hello-bindle` — the only intents in the repository with a non-empty
 *    `deps`, and the only ones produced by the *production* lowering path
 *    rather than by a test helper. `packages/cloud/src/intent.ts`
 *    (`lowerManifest`) maps `packages/cloud/test/fixtures/hello-bindle.manifest.json`
 *    onto them, and `hello-bindle.test.ts` re-derives the parts of that mapping
 *    it can check without importing `@hobo/cloud`.
 */
export type ExistingIntent = {
	readonly id: string;
	readonly source: string;
	readonly anchor: string;
	readonly value: ResourceIntent;
};

const CLOUD_PLACEMENT_TEST = "packages/cloud/test/placement.test.ts";
const CLOUD_REGISTRY_TEST = "packages/cloud/test/registry.test.ts";
const CLOUD_BOUNDARY_CONTRACT =
	"packages/cloud/contracts/consumer/control-plane-boundaries.test.ts";
const CLOUD_INTENT_SRC = "packages/cloud/src/intent.ts";

function kvIntent(overrides: Partial<ResourceIntent> = {}): ResourceIntent {
	return {
		name: "cache",
		port: "kv",
		require: [],
		prefer: [],
		negotiation: "require",
		deps: [],
		objective: "min-cost",
		...overrides,
	};
}

export const EXISTING_INTENTS: readonly ExistingIntent[] = [
	{
		id: "placement/baseline",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `name: "cache",
		port: "kv",
		require: [],
		prefer: [],
		negotiation: "require",
		deps: [],
		objective: "min-cost",`,
		value: kvIntent(),
	},
	{
		id: "placement/selector-region-eq",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "region", op: "eq", values: ["us-east-1"] }],`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "region", op: "eq", values: ["us-east-1"] }],
				affinities: [],
			},
		}),
	},
	{
		id: "placement/selector-cost-lt",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "cost", op: "lt", values: ["0.008"] }],`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "cost", op: "lt", values: ["0.008"] }],
				affinities: [],
			},
		}),
	},
	{
		id: "placement/selector-encryption-exists",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "encryption", op: "exists", values: [] }],`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "encryption", op: "exists", values: [] }],
				affinities: [],
			},
		}),
	},
	{
		id: "placement/selector-latency-lte",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "latency", op: "lte", values: ["25"] }],`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "latency", op: "lte", values: ["25"] }],
				affinities: [],
			},
		}),
	},
	{
		id: "placement/selector-region-unsatisfiable",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "region", op: "eq", values: ["mars-north-1"] }],`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "region", op: "eq", values: ["mars-north-1"] }],
				affinities: [],
			},
		}),
	},
	{
		id: "placement/anti-affinity-database-yard",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `{ mode: "anti-affinity", targetPort: "database", scope: "yard" },`,
		value: kvIntent({
			placement: {
				selectors: [],
				affinities: [
					{ mode: "anti-affinity", targetPort: "database", scope: "yard" },
				],
			},
		}),
	},
	{
		id: "placement/affinity-database-yard",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `{ mode: "affinity", targetPort: "database", scope: "yard" },`,
		value: kvIntent({
			placement: {
				selectors: [],
				affinities: [
					{ mode: "affinity", targetPort: "database", scope: "yard" },
				],
			},
		}),
	},
	{
		id: "placement/affinity-database-region",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `{ mode: "affinity", targetPort: "database", scope: "region" },`,
		value: kvIntent({
			placement: {
				selectors: [],
				affinities: [
					{ mode: "affinity", targetPort: "database", scope: "region" },
				],
			},
		}),
	},
	{
		id: "placement/anti-affinity-database-region",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `{ mode: "anti-affinity", targetPort: "database", scope: "region" },`,
		value: kvIntent({
			placement: {
				selectors: [],
				affinities: [
					{ mode: "anti-affinity", targetPort: "database", scope: "region" },
				],
			},
		}),
	},
	{
		id: "placement/anti-affinity-queue-yard",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `{ mode: "anti-affinity", targetPort: "queue", scope: "yard" },`,
		value: kvIntent({
			placement: {
				selectors: [],
				affinities: [
					{ mode: "anti-affinity", targetPort: "queue", scope: "yard" },
				],
			},
		}),
	},
	{
		id: "placement/spread-region",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `name: "cache-b",
				placement: criteria({ spread: { dimension: "region" } }),`,
		value: kvIntent({
			name: "cache-b",
			placement: {
				selectors: [],
				affinities: [],
				spread: { dimension: "region" },
			},
		}),
	},
	{
		id: "placement/spread-yard",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `name: "cache-b",
				placement: criteria({ spread: { dimension: "yard" } }),`,
		value: kvIntent({
			name: "cache-b",
			placement: {
				selectors: [],
				affinities: [],
				spread: { dimension: "yard" },
			},
		}),
	},
	{
		id: "placement/pick-n-2",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `kvIntent({ placement: criteria({ pickN: { count: 2 } }) }),`,
		value: kvIntent({
			placement: { selectors: [], affinities: [], pickN: { count: 2 } },
		}),
	},
	{
		id: "placement/pick-n-2-region-pinned",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "region", op: "eq", values: ["us-east-1"] }],
					pickN: { count: 2 },`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "region", op: "eq", values: ["us-east-1"] }],
				affinities: [],
				pickN: { count: 2 },
			},
		}),
	},
	{
		id: "placement/determinism-selector-and-affinity",
		source: CLOUD_PLACEMENT_TEST,
		anchor: `selectors: [{ key: "region", op: "in", values: ["us-east-1"] }],
				affinities: [
					{ mode: "anti-affinity", targetPort: "queue", scope: "yard" },
				],`,
		value: kvIntent({
			placement: {
				selectors: [{ key: "region", op: "in", values: ["us-east-1"] }],
				affinities: [
					{ mode: "anti-affinity", targetPort: "queue", scope: "yard" },
				],
			},
		}),
	},
	{
		id: "registry/ledger-namespaced-port",
		source: CLOUD_REGISTRY_TEST,
		anchor: `name: "ledger",
		port,
		require: [],
		prefer: [],
		negotiation: "require",
		deps: [],
		objective: "min-cost",`,
		value: {
			name: "ledger",
			port: "hobo:database",
			require: [],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		},
	},
	{
		id: "contract/catalog-service-compute",
		source: CLOUD_BOUNDARY_CONTRACT,
		anchor: `name: "service",
			port: "compute",
			require: ["http"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",`,
		value: {
			name: "service",
			port: "compute",
			require: ["http"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		},
	},
	{
		id: "contract/registry-checkout-api-gpu",
		source: CLOUD_BOUNDARY_CONTRACT,
		anchor: `name: "checkout-api",
			port: "compute",
			require: ["gpu"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",`,
		value: {
			name: "checkout-api",
			port: "compute",
			require: ["gpu"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		},
	},
	{
		id: "hello-bindle/assets",
		source: CLOUD_INTENT_SRC,
		anchor: `capabilityPort: "objectStore",
		require: ["durable"],`,
		value: {
			name: "assets",
			port: "objectStore",
			require: ["durable"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		},
	},
	{
		id: "hello-bindle/sessions",
		source: CLOUD_INTENT_SRC,
		anchor: `{ match: (p) => /kv/i.test(p), capabilityPort: "kv", require: ["eventual"] },`,
		value: {
			name: "sessions",
			port: "kv",
			require: ["eventual"],
			prefer: [],
			negotiation: "require",
			deps: [],
			objective: "min-cost",
		},
	},
	{
		id: "hello-bindle/service",
		source: CLOUD_INTENT_SRC,
		anchor: `capabilityPort = "compute";
				require = ["http"];`,
		value: {
			name: "service",
			port: "compute",
			require: ["http"],
			prefer: [],
			negotiation: "require",
			deps: ["assets", "sessions"],
			objective: "min-cost",
		},
	},
];
