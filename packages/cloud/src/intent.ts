import type { ManifestV1 } from "@hobo/bindles";

import type { ResourceIntent } from "./plan-types.js";

// Planner step 0 (control-plane.md): lower each `hobo.manifest/v1` resource node
// to a provider-neutral ResourceIntent (capability class + required features +
// bind-edge deps + routing objective). Provider names, SKUs, and regions enter
// only later, after matching — this stage is deliberately provider-agnostic.

export interface LowerOptions {
	objective?: string;
	region?: string;
}

// Capability-class + required-feature mapping per manifest resource shape. The
// required features are the agnostic port contract; a provider Capability must
// satisfy them (control-plane.md "capability negotiation").
const DATA_PORT_RULES: ReadonlyArray<{
	match: (port: string) => boolean;
	capabilityPort: string;
	require: string[];
}> = [
	{ match: (p) => /kv/i.test(p), capabilityPort: "kv", require: ["eventual"] },
	{
		match: (p) => /object\s*store|blob|bucket|r2/i.test(p),
		capabilityPort: "objectStore",
		require: ["durable"],
	},
];

interface LoweredDataPort {
	capabilityPort: string;
	require: string[];
}

function lowerDataPort(port: string, paradigm?: string): LoweredDataPort {
	// A provider-owned project groups resources; it does not serve HTTP itself.
	if ((port === "hobo:data" || port === "data") && paradigm === "project")
		return { capabilityPort: "project", require: [] };
	if ((port === "hobo:data" || port === "data") && paradigm === "secret")
		return { capabilityPort: "secretRef", require: [] };
	for (const rule of DATA_PORT_RULES) {
		if (rule.match(port)) {
			return { capabilityPort: rule.capabilityPort, require: rule.require };
		}
	}
	// Unmapped ports pass through their bare token (e.g. `hobo:database` ->
	// `database`); no seed provider advertises them, so matching rejects with
	// remediation — exactly the agent-self-correction path.
	const bare = port.includes(":") ? (port.split(":").pop() ?? port) : port;
	return { capabilityPort: bare, require: [] };
}

export function lowerManifest(
	manifest: ManifestV1,
	options: LowerOptions = {},
): ResourceIntent[] {
	const objective = options.objective ?? "min-cost";
	const resources = manifest.value.resources;
	const intents: ResourceIntent[] = [];

	// Deterministic order: sort resource ids so the plan DAG is byte-stable.
	for (const name of Object.keys(resources).sort()) {
		const resource = resources[name];
		if (!resource) continue;

		let capabilityPort: string;
		let require: string[];
		switch (resource.type) {
			case "component.v1":
			case "website.v1":
				capabilityPort = "compute";
				require = ["http"];
				break;
			case "data.v1": {
				const lowered = lowerDataPort(resource.port ?? "", resource.paradigm);
				capabilityPort = lowered.capabilityPort;
				require = lowered.require;
				if (capabilityPort === "secretRef" && resource.paradigm === "secret") {
					const access = resource.allow ?? [];
					if (access.some((verb) => verb !== "access" && verb !== "put"))
						throw new Error(
							"secret resource has an unsupported access operation",
						);
					require = [...new Set(access)].sort();
				}
				break;
			}
			default:
				capabilityPort = resource.type;
				require = [];
		}

		// bind edges (control-plane.md step 1: collect `bind` edges into the DAG).
		const deps = Array.isArray(resource.bind) ? [...resource.bind].sort() : [];

		const intent: ResourceIntent = {
			name,
			port: capabilityPort,
			require,
			prefer: [],
			negotiation: "require",
			deps,
			objective,
		};
		if (options.region !== undefined) intent.region = options.region;
		intents.push(intent);
	}

	return intents;
}
