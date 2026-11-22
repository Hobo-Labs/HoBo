import type { ManifestV1 } from "@hobo/bindles";

import { isJsonObject, isJsonString, type JsonObject } from "./json.js";
import type { ResourceIntent } from "./plan-types.js";

export interface LowerOptions {
	objective?: string;
	region?: string;
}

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

// The capability port a generic `data` resource asks for, by its paradigm
// (the Bindle loader writes `data(<paradigm>)` for every backing resource:
// `kv` is key-value, `queue` is a queue, and so on). Without this a KV cache,
// a queue and a secret all asked for the bare `data` port, which no provider
// advertises, so nothing a Bindle declared could ever be matched.
const DATA_PARADIGM_PORTS = new Map<string, LoweredDataPort>([
	["project", { capabilityPort: "project", require: [] }],
	// SDK key-value declarations do not imply a consistency guarantee.
	["key-value", { capabilityPort: "kv", require: [] }],
	["object", { capabilityPort: "objectStore", require: ["durable"] }],
	["relational", { capabilityPort: "database", require: [] }],
	["queue", { capabilityPort: "queue", require: [] }],
	["topic", { capabilityPort: "topic", require: [] }],
	["secret", { capabilityPort: "secretRef", require: [] }],
	["schedule", { capabilityPort: "schedule", require: [] }],
]);

function lowerDataPort(port: string, paradigm?: string): LoweredDataPort {
	if (port === "hobo:cache")
		return { capabilityPort: "kv", require: ["ttl", "atomicCompareAndSet"] };
	if ((port === "hobo:data" || port === "data") && paradigm !== undefined) {
		const byParadigm = DATA_PARADIGM_PORTS.get(paradigm);
		if (byParadigm !== undefined)
			return {
				capabilityPort: byParadigm.capabilityPort,
				require: [...byParadigm.require],
			};
	}
	for (const rule of DATA_PORT_RULES) {
		if (rule.match(port)) {
			return { capabilityPort: rule.capabilityPort, require: rule.require };
		}
	}
	const bare = port.includes(":") ? (port.split(":").pop() ?? port) : port;
	return { capabilityPort: bare, require: [] };
}

/** A five-field cron expression, as the cadence trait writes it. */
function isCadence<T>(value: T): value is T & string {
	return isJsonString(value) && /^\S+(\s+\S+){4}$/u.test(value);
}

export function lowerManifest(
	manifest: ManifestV1,
	options: LowerOptions = {},
): ResourceIntent[] {
	const objective = options.objective ?? "min-cost";
	const resources = manifest.value.resources;
	const intents: ResourceIntent[] = [];

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

		if (
			resource.annotations !== undefined &&
			!isJsonObject(resource.annotations)
		) {
			throw new Error(`resource ${name} annotations must be an object`);
		}
		const readyDeps = readinessDependencies(
			name,
			resource.annotations,
			"waitFor",
			"ready",
			resources,
		);
		const completedDeps = readinessDependencies(
			name,
			resource.annotations,
			"waitForCompletion",
			"completed",
			resources,
		);
		if (readyDeps.some((dependency) => completedDeps.includes(dependency))) {
			throw new Error(
				`resource ${name} cannot require both readiness and completion for one dependency`,
			);
		}
		const deps = [
			...new Set([
				...(resource.bind ?? []),
				...(resource.links ?? []).map((link) => link.to),
				...readyDeps,
				...completedDeps,
			]),
		].sort();

		const intent: ResourceIntent = {
			name,
			port: capabilityPort,
			require,
			prefer: [],
			negotiation: "require",
			deps,
			objective,
		};
		if (readyDeps.length > 0) intent.readyDeps = readyDeps;
		if (completedDeps.length > 0) intent.completedDeps = completedDeps;
		if (options.region !== undefined) intent.region = options.region;
		const cadence = resource.annotations?.cadence;
		if (capabilityPort === "schedule" && isCadence(cadence))
			intent.cadence = cadence;
		intents.push(intent);
	}

	return intents;
}

function readinessDependencies(
	name: string,
	annotations: JsonObject | undefined,
	field: "waitFor" | "waitForCompletion",
	condition: "ready" | "completed",
	resources: ManifestV1["value"]["resources"],
): string[] {
	const input = annotations?.[field];
	if (input === undefined) return [];
	if (!Array.isArray(input))
		throw new Error(`resource ${name} ${field} must be an array`);
	const result: string[] = [];
	for (const entry of input) {
		if (
			!isJsonObject(entry) ||
			!isJsonString(entry.to) ||
			entry.until !== condition ||
			entry.to === name ||
			!Object.hasOwn(resources, entry.to) ||
			result.includes(entry.to)
		) {
			throw new Error(`resource ${name} has an invalid ${field} dependency`);
		}
		result.push(entry.to);
	}
	return result.sort();
}
