/**
 * Scope derivation: the three availability slices of ADR-0077 / Plan 49.
 *
 * - **station**: HoBo control-plane capability surfaces on one Station.
 * - **primitives**: the closed Bindle-primitive vocabulary (web, api, kv, …)
 *   imported from `@hobo/capability-profiles` — no fourth duplicated list.
 * - **project / bindle**: the user-centric slices. Every Bindle gets a page
 *   (default-on with opt-out, session-replay convention); Projects group
 *   Bindle pages plus their configured service dependencies.
 */
import {
	type BindleDefinition,
	type BindleResourceRecord,
	isAppKitKind,
	isStatusPageAnnotation,
	readDependencyConfig,
	readStatusPageConfig,
} from "@hobo/bindles";
import { BINDLE_PRIMITIVES } from "@hobo/capability-profiles";
import type { ComponentSpec, StatusScope } from "./types.js";
import {
	isStringValue,
	parseComponentSpec,
	parseStatusScope,
} from "./types.js";

/** Default project grouping when a Bindle declares none (ADR-0077 §1). */
export const DEFAULT_PROJECT = "default" as const;

const LABEL_SAFE = /[^a-z0-9._-]+/g;

function safeId(value: string): string {
	const lowered = value.toLowerCase().replace(LABEL_SAFE, "-");
	const trimmed = lowered.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
	return trimmed.length > 0 ? trimmed : "unnamed";
}

/** Station slice: one component per station capability surface. */
export function stationStatusScope(stationId: string): StatusScope {
	return parseStatusScope({
		kind: "station",
		id: safeId(stationId),
		label: `Station ${stationId}`,
	});
}

export function stationCapabilityComponents(
	capabilities: readonly { readonly kind: string; readonly slug: string }[],
): readonly ComponentSpec[] {
	const seen = new Set<string>();
	const specs: ComponentSpec[] = [];
	for (const capability of capabilities) {
		const id = safeId(`${capability.kind}-${capability.slug}`);
		if (seen.has(id)) continue;
		seen.add(id);
		specs.push(
			parseComponentSpec({
				id,
				label: `${capability.slug} (${capability.kind})`,
				kind: capability.kind === "sidecar" ? "sidecar" : "capability",
			}),
		);
	}
	return Object.freeze(specs);
}

/** Primitives slice: the closed HoBo primitive vocabulary, one component each. */
export function primitivesStatusScope(id = "hobo"): StatusScope {
	return parseStatusScope({
		kind: "primitives",
		id: safeId(id),
		label: "HoBo primitives",
	});
}

export function primitiveComponents(): readonly ComponentSpec[] {
	return Object.freeze(
		BINDLE_PRIMITIVES.map((primitive) =>
			parseComponentSpec({
				id: safeId(primitive),
				label: primitive,
				kind: "primitive",
			}),
		),
	);
}

export interface DisabledComponent {
	readonly id: string;
	readonly reason: "opted-out";
}

export interface BindleStatusPlan {
	readonly scope: StatusScope;
	readonly project: string;
	readonly components: readonly ComponentSpec[];
	readonly disabledComponents: readonly DisabledComponent[];
	/**
	 * Why this plan exists. `default-on` is the ADR-0145 platform-applied
	 * trait path — a page for every Bindle without any annotation.
	 */
	readonly reason: "default-on" | "annotated";
}

function dependencyLabel(record: BindleResourceRecord): string {
	const config = readDependencyConfig(record.annotations);
	if (config && isStringValue(config.image)) {
		return `${record.name} (${config.image})`;
	}
	if (config && isStringValue(config.source)) {
		return `${record.name} (${config.source})`;
	}
	return record.name;
}

/**
 * Derive the status-page plan for one Bindle. Read-side default-on: every
 * Bindle gets a plan whether or not it carries a `status-page` annotation
 * (the session-replay opt-out convention, ADR-0137/ADR-0145). App Kits and
 * declared dependencies become components; `statusPage({ enabled: false })`
 * on a resource excludes that component but never deletes the page.
 */
export function deriveBindleStatusPlan(
	definition: BindleDefinition,
): BindleStatusPlan {
	const components: ComponentSpec[] = [];
	const disabled: DisabledComponent[] = [];
	let project: string | undefined;
	let label: string | undefined;
	let annotated = false;

	for (const record of Object.values(definition.resources)) {
		const config = readStatusPageConfig(record.annotations);
		if (record.annotations.some(isStatusPageAnnotation)) {
			annotated = true;
			if (config?.project !== undefined && project === undefined) {
				project = config.project;
			}
			if (config?.label !== undefined && label === undefined) {
				label = config.label;
			}
		}
		const isDependency = readDependencyConfig(record.annotations) !== null;
		const isKit = isAppKitKind(record.kind);
		if (!isKit && !isDependency) continue;
		const id = safeId(`${isDependency ? "dep" : "kit"}-${record.name}`);
		if (config?.enabled === false) {
			disabled.push(Object.freeze({ id, reason: "opted-out" as const }));
			continue;
		}
		components.push(
			parseComponentSpec({
				id,
				label: isDependency ? dependencyLabel(record) : record.name,
				kind: isDependency ? "dependency" : "app-kit",
			}),
		);
	}

	return Object.freeze({
		scope: parseStatusScope({
			kind: "bindle",
			id: safeId(definition.name),
			label: label ?? `${definition.name} status`,
		}),
		project: project ?? DEFAULT_PROJECT,
		components: Object.freeze(components),
		disabledComponents: Object.freeze(disabled),
		reason: annotated ? "annotated" : "default-on",
	});
}

export interface ProjectStatusPlan {
	readonly scope: StatusScope;
	readonly project: string;
	readonly bindles: readonly BindleStatusPlan[];
	/** One rollup component per Bindle plus deduplicated dependencies. */
	readonly components: readonly ComponentSpec[];
}

/**
 * Group Bindle plans into project pages. Every project referenced by at
 * least one Bindle gets a page; a Bindle with no project lands in
 * `default`. Duplicate dependency components across Bindles deduplicate by
 * id so a shared database shows once.
 */
export function deriveProjectStatusPlans(
	definitions: readonly BindleDefinition[],
): readonly ProjectStatusPlan[] {
	const byProject = new Map<string, BindleStatusPlan[]>();
	for (const definition of definitions) {
		const plan = deriveBindleStatusPlan(definition);
		const bucket = byProject.get(plan.project) ?? [];
		bucket.push(plan);
		byProject.set(plan.project, bucket);
	}
	return Object.freeze(
		[...byProject.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([project, plans]) => {
				const components: ComponentSpec[] = [];
				const seen = new Set<string>();
				for (const plan of plans) {
					const bindleComponentId = safeId(`bindle-${plan.scope.id}`);
					if (!seen.has(bindleComponentId)) {
						seen.add(bindleComponentId);
						components.push(
							parseComponentSpec({
								id: bindleComponentId,
								label: plan.scope.label,
								kind: "bindle",
							}),
						);
					}
					for (const component of plan.components) {
						if (component.kind !== "dependency" || seen.has(component.id)) {
							continue;
						}
						seen.add(component.id);
						components.push(component);
					}
				}
				return Object.freeze({
					scope: parseStatusScope({
						kind: "project",
						id: safeId(project),
						label: `Project ${project}`,
					}),
					project,
					bindles: Object.freeze(plans),
					components: Object.freeze(components),
				});
			}),
	);
}
