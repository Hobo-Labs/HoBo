import { type JsonObject, parseJsonObject } from "./json.js";
import {
	COST_FACTS,
	DEFAULT_REGIONS,
	GITHUB_RUNNER_PROVIDER_ID,
	publishCapabilityManifest,
} from "./manifest.js";
import {
	BUILD_MACHINE_CATEGORY,
	CATEGORY_PORTS,
	type ExecutionHostCategory,
	RUNNER_CATEGORY,
} from "./types.js";

// The M0 catalog entry for `hobo add runner-github` (HOBO-710 registry model):
// a registrable snapshot of both execution-host ports whose Capability
// Manifest lands in the provider.Registered fact. Structurally matches
// @hobo/cloud's RegistrableProvider so the composition root registers it
// without this package depending on the kernel.

const FEATURES = {
	[RUNNER_CATEGORY]: ["ci-job", "workflow-dispatch"],
	[BUILD_MACHINE_CATEGORY]: ["container-build", "ghcr-publish"],
} satisfies Record<ExecutionHostCategory, string[]>;

export interface GithubRunnerCatalogEntry {
	id: string;
	regions: string[];
	capabilities: Array<{
		port: string;
		satisfies(req: { port: string; features?: string[] }): {
			kind: string;
			missing?: string[];
		};
		estimateCost(req: { port: string }): {
			marginalPrice: string;
			sku: string;
			unit: string;
		};
	}>;
	capabilityManifest(): {
		providerId: string;
		published: Record<string, string>;
		capabilities: JsonObject;
		cost: JsonObject;
	};
}

export function createGithubRunnerCatalogEntry(): GithubRunnerCatalogEntry {
	const published = publishCapabilityManifest();
	const categories: ExecutionHostCategory[] = [
		RUNNER_CATEGORY,
		BUILD_MACHINE_CATEGORY,
	];

	return {
		id: GITHUB_RUNNER_PROVIDER_ID,
		regions: [...DEFAULT_REGIONS],
		capabilities: categories.map((category) => {
			const port = CATEGORY_PORTS[category];
			const features = FEATURES[category];
			const fact = COST_FACTS[category];
			return {
				port,
				satisfies(req: { port: string; features?: string[] }) {
					if (req.port !== port) {
						return { kind: "none" };
					}
					const missing = (req.features ?? []).filter(
						(feature) => !features.includes(feature),
					);
					return missing.length === 0
						? { kind: "full" }
						: { kind: "partial", missing };
				},
				estimateCost() {
					return {
						marginalPrice: fact.marginalPrice,
						sku: fact.sku,
						unit: fact.unit,
					};
				},
			};
		}),
		capabilityManifest() {
			return {
				providerId: GITHUB_RUNNER_PROVIDER_ID,
				published: { ...published },
				capabilities: parseJsonObject(
					published["/.well-known/capability-manifest/capabilities.json"],
				),
				cost: parseJsonObject(
					published["/.well-known/capability-manifest/cost.json"],
				),
			};
		},
	};
}
