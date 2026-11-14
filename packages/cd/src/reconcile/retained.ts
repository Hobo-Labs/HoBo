// Retained fields (D22): fields a controller on the target side owns, such as
// autoscaler replicas or a provider-managed runtime version. They are excluded
// from drift and reported as `retained`. Three declaration sources merge:
//   1. a resolver component's `describe` (the realizer copies them into
//      ResourceObservation.retained);
//   2. the in-tree table below, keyed by resource kind;
//   3. the Camp mapping-rule property `hobo.cd/retain`, which Matching copies
//      into the resource's realizationParameters.
import { clone, create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import {
	type ResourceObservation,
	ResourceObservationSchema,
} from "../_generated/cd_pb.js";

// public-contract: Camp mapping-rule property naming retained fields.
export const RETAIN_PROPERTY = "hobo.cd/retain" as const;

const AUTOSCALED = Object.freeze(["replicas", "instances", "desiredCount"]);
const MANAGED_RUNTIME = Object.freeze(["runtimeVersion", "platformVersion"]);

// public-contract: the in-tree retained-field table, keyed by resource kind
// (the plan resource's port). Lookups also try the kind's last segment, so
// `hobo:http-service` and `http-service` share an entry.
export const RETAINED_FIELDS: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		compute: AUTOSCALED,
		container: AUTOSCALED,
		workload: AUTOSCALED,
		"http-service": AUTOSCALED,
		"web-app": AUTOSCALED,
		deployment: AUTOSCALED,
		function: MANAGED_RUNTIME,
		serverless: MANAGED_RUNTIME,
		database: Object.freeze(["engineMinorVersion", "storageAutoscaledGb"]),
		db: Object.freeze(["engineMinorVersion", "storageAutoscaledGb"]),
		kv: Object.freeze(["storageAutoscaledGb"]),
		queue: Object.freeze(["partitionsAutoscaled"]),
	});

/** Retained fields declared by the in-tree table for one resource kind. */
export function tableRetained(kind: string): readonly string[] {
	const direct = RETAINED_FIELDS[kind];
	if (direct) return direct;
	const last = kind.split(/[:.]/u).at(-1) ?? kind;
	return RETAINED_FIELDS[last] ?? [];
}

/** Parse `hobo.cd/retain` from a realization parameter: "a,b" or ["a","b"]. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: parse boundary for an untyped realizationParameters JSON value.
export function parseRetainProperty(value: unknown): readonly string[] {
	const raw =
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the property is either a comma list or a JSON string array.
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value.filter(
						// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: keep only string entries of the JSON array.
						(item): item is string => typeof item === "string",
					)
				: [];
	return Object.freeze(
		[
			...new Set(raw.map((field) => field.trim()).filter((f) => f !== "")),
		].sort(),
	);
}

/** Mapping-rule retained fields per resource name of a resolved set. */
export function mappingRetained(
	resolved: ResolvedDeploymentSet,
): ReadonlyMap<string, readonly string[]> {
	const out = new Map<string, readonly string[]>();
	for (const resource of resolved.plan.resources) {
		const fields = parseRetainProperty(
			resource.realizationParameters?.[RETAIN_PROPERTY],
		);
		if (fields.length > 0) out.set(resource.name, fields);
	}
	return out;
}

/** The merged retained-field set for one observed resource. */
export function mergeRetained(
	input: Readonly<{
		kind: string;
		component: readonly string[];
		mapping: readonly string[];
	}>,
): readonly string[] {
	return Object.freeze(
		[
			...new Set([
				...input.component,
				...tableRetained(input.kind),
				...input.mapping,
			]),
		].sort(),
	);
}

// public-contract: drift classes a realizer may report in drift_kind.
export const DRIFT_CLASSES = Object.freeze([
	"modified",
	"deleted",
	"orphan",
	"external",
] as const);

export type DriftClass = (typeof DRIFT_CLASSES)[number] | "unknown";

/** Parsed `drift_kind`: `<class>` or `<class>:<field>[,<field>...]`. */
export type DriftKind = Readonly<{
	driftClass: DriftClass;
	fields: readonly string[];
}>;

export function parseDriftKind(value: string): DriftKind | undefined {
	const text = value.trim();
	if (text === "") return undefined;
	const [head = "", rest = ""] = text.split(/:(.*)/su);
	const known = DRIFT_CLASSES.find((name) => name === head);
	const fields = rest
		.split(",")
		.map((field) => field.trim())
		.filter((field) => field !== "");
	return Object.freeze({
		driftClass: known ?? "unknown",
		fields: Object.freeze([...new Set(fields)].sort()),
	});
}

export function formatDriftKind(kind: DriftKind): string {
	return kind.fields.length === 0
		? kind.driftClass
		: `${kind.driftClass}:${kind.fields.join(",")}`;
}

/**
 * Apply retained fields to one observed resource. A `modified` drift whose
 * every changed field is retained is not drift; a mixed one keeps only the
 * non-retained fields. A `modified` drift naming no fields stays drift (fail
 * closed: the realizer did not prove the change was retained).
 */
export function applyRetained(
	resource: ResourceObservation,
	retained: readonly string[],
): ResourceObservation {
	const merged = [...new Set([...resource.retained, ...retained])].sort();
	const next = clone(ResourceObservationSchema, resource);
	next.retained = merged;
	const kind = parseDriftKind(resource.driftKind);
	if (kind?.driftClass === "modified" && kind.fields.length > 0) {
		const keep = new Set(merged);
		const remaining = kind.fields.filter((field) => !keep.has(field));
		next.driftKind =
			remaining.length === 0
				? ""
				: formatDriftKind({ driftClass: "modified", fields: remaining });
	}
	return next;
}

export function emptyResourceObservation(name: string): ResourceObservation {
	return create(ResourceObservationSchema, { resource: name });
}
