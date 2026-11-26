import { clone, create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import {
	type ResourceObservation,
	ResourceObservationSchema,
} from "../_generated/cd_pb.js";

export const RETAIN_PROPERTY = "hobo.cd/retain" as const;

const AUTOSCALED = Object.freeze(["replicas", "instances", "desiredCount"]);
const MANAGED_RUNTIME = Object.freeze(["runtimeVersion", "platformVersion"]);

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

export function tableRetained(kind: string): readonly string[] {
	const direct = RETAINED_FIELDS[kind];
	if (direct) return direct;
	const last = kind.split(/[:.]/u).at(-1) ?? kind;
	return RETAINED_FIELDS[last] ?? [];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseRetainProperty(value: unknown): readonly string[] {
	const raw =
		// oxlint-disable-next-line anti-slop/no-runtime-typeof
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value.filter(
						// oxlint-disable-next-line anti-slop/no-runtime-typeof
						(item): item is string => typeof item === "string",
					)
				: [];
	return Object.freeze(
		[
			...new Set(raw.map((field) => field.trim()).filter((f) => f !== "")),
		].sort(),
	);
}

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

export const DRIFT_CLASSES = Object.freeze([
	"modified",
	"deleted",
	"orphan",
	"external",
] as const);

export type DriftClass = (typeof DRIFT_CLASSES)[number] | "unknown";

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
