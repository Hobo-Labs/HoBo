import { isJsonObject, type JsonObject } from "../json.js";
import { deepFreeze } from "../parse-utils.js";
import { inferCapabilityUsage } from "./infer-usage.js";
import type {
	CapabilityDiagnostic,
	CapabilityGrant,
	GrantEvaluation,
} from "./types.js";

interface ManifestResource {
	type?: string;
	port?: string;
	allow?: string[];
	usage?: {
		inferred?: string[];
		source?: string;
	};
	links?: Array<{ import: string; to: string }>;
}

interface ManifestGrant {
	schema?: string;
	resources?: Record<string, ManifestResource>;
}

export function evaluateCapabilityGrants({
	sourceText,
	manifest,
	fileName = "bindle.ts",
}: {
	sourceText: string;
	manifest: unknown;
	fileName?: string;
}): GrantEvaluation {
	if (!manifest || !isJsonObject(manifest) || Array.isArray(manifest)) {
		throw new TypeError("manifest must be an object");
	}

	const usage = inferCapabilityUsage({ sourceText, fileName });
	// SAFETY: assertion required at this I/O or test boundary.
	const nextManifest = structuredClone(manifest) as ManifestGrant;
	const diagnostics: CapabilityDiagnostic[] = [...usage.diagnostics];
	const usageByResource = new Map(
		usage.resources.map((resource) => [resource.resource, resource]),
	);

	for (const [resourceId, resource] of Object.entries(
		nextManifest.resources ?? {},
	)) {
		if (resource.type === "component.v1") {
			continue;
		}

		const inferred = usageByResource.get(resourceId)?.operations ?? [];
		resource.usage = {
			inferred: [...inferred],
			source: "static-analysis",
		};

		const allowed = Array.isArray(resource.allow)
			? [...resource.allow].sort()
			: [...inferred];
		const outsideAllow = inferred.filter(
			(operation) => !allowed.includes(operation),
		);
		if (outsideAllow.length > 0) {
			diagnostics.push({
				code: "capability.allow.narrow-below-usage",
				severity: "error",
				resource: resourceId,
				allowedOperations: allowed,
				observedOperations: outsideAllow,
				message: `Resource ${resourceId} observes capability operations outside declared .allow().`,
				fileName,
				line: 0,
			});
		}
	}

	const grants: CapabilityGrant[] = [];
	for (const [componentId, resource] of Object.entries(
		nextManifest.resources ?? {},
	)) {
		if (resource.type !== "component.v1") {
			continue;
		}

		for (const link of resource.links ?? []) {
			const target = nextManifest.resources?.[link.to];
			if (!target || target.type === "component.v1") {
				continue;
			}
			const inferred = target.usage?.inferred ?? [];
			const allowed = Array.isArray(target.allow) ? target.allow : inferred;
			const operations = inferred
				.filter((operation) => allowed.includes(operation))
				.sort();
			if (operations.length === 0) {
				continue;
			}
			grants.push({
				componentId,
				importInterface: link.import,
				resource: link.to,
				operations,
			});
		}
	}

	return Object.freeze({
		schema: "hobo.capability-enforcement/v1",
		ok:
			usage.ok &&
			!diagnostics.some((diagnostic) => diagnostic.severity === "error"),
		canDeployDimension: "capabilityGrants",
		diagnostics: Object.freeze(diagnostics),
		// SAFETY: assertion required at this I/O or test boundary.
		manifest: deepFreeze(nextManifest) as JsonObject,
		grants: Object.freeze(
			grants.map((grant) =>
				Object.freeze({
					...grant,
					operations: Object.freeze([...grant.operations]),
				}),
			),
		),
	});
}
