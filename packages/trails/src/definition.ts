/**
 * Trail definition model — versioned, composable, app-owned runbooks.
 * Parse-don't-validate: constructors are the only way to build definitions.
 */
import { createHash } from "node:crypto";
import { isJsonObject, type JsonValue } from "./json.js";

// public-contract: trail definition schema version.
export const TRAIL_DEFINITION_SCHEMA = "hobo.trail-definition/v1" as const;

export type TrailStepKind =
	| "schema"
	| "data-transform"
	| "continuous-dual-data"
	| "identity-continuous"
	| "junction-rebind"
	| "secretless-reresolve"
	| "validation"
	| "cutover"
	| "compose"
	| "custom";

/** The closed pattern catalog, mirrored structurally from `@hobo/data-core`. */
export const TRAIL_DATA_PATTERNS = Object.freeze([
	"in-place-evolve",
	"rebuild-and-swap",
	"offline-copy",
	"snapshot-and-tail",
	"log-pivot",
	"stream-handoff",
] as const);
export type TrailDataPattern = (typeof TRAIL_DATA_PATTERNS)[number];

export type TrailStep = Readonly<{
	id: string;
	kind: TrailStepKind;
	description?: string;
	/** Depends on other step ids within the same Trail. */
	dependsOn?: readonly string[];
	/** Platform recipe id when kind is compose. */
	recipeId?: string;
	/** Nested Trail id when composing another Trail. */
	trailRef?: string;
	/** Schema SQL (versioned) or desired-state hash. */
	schema?: Readonly<{
		mode: "versioned-sql" | "declarative-desired" | "expand-contract";
		sql?: string;
		desiredHash?: string;
		version: string;
	}>;
	/** Data transform (script id or inline checksummed body — no secrets). */
	data?: Readonly<{
		mode: "bulk" | "delta" | "cdc-dual";
		transformId: string;
		checksum: `sha256:${string}`;
		/**
		 * The migration pattern this step realizes (ADR-0177 pattern catalog).
		 * Optional so existing definitions keep their content hash.
		 */
		pattern?: TrailDataPattern;
	}>;
	/** Identity continuous — zero app fields required; platform derives MappingSpec. */
	identity?: Readonly<{
		/** Optional override; Matching supplies adapters when omitted. */
		sourceAdapter?: string;
		targetAdapter?: string;
		/** Continuous dual is always preferred. */
		continuous: true;
		bindleConfigRequired: false;
	}>;
	/** Junction / overlay reachability for cross-cloud duals. */
	junction?: Readonly<{
		required: boolean;
		sourceYard?: string;
		targetYard?: string;
	}>;
	/** Validation oracle id (Golden suite target). */
	oracleId?: string;
	/** Progressive ramp via Harness when true. */
	progressive?: boolean;
}>;

export type TrailDefinition = Readonly<{
	schemaVersion: typeof TRAIL_DEFINITION_SCHEMA;
	id: string;
	/** Trail version (semver or timestamp-like). */
	version: string;
	description: string;
	/** Target environment class. */
	targets: readonly string[];
	/** Other Trail ids this Trail depends on. */
	dependsOnTrails?: readonly string[];
	steps: readonly TrailStep[];
	/** Platform continuous recipes embedded by id. */
	recipeList?: readonly string[];
	contentHash: `sha256:${string}`;
}>;

export type TrailDefinitionInput = {
	readonly id: string;
	readonly version: string;
	readonly description?: string;
	readonly targets?: readonly string[];
	readonly dependsOnTrails?: readonly string[];
	readonly steps?: readonly TrailStep[];
	readonly recipeList?: readonly string[];
};

/**
 * Parse a Trail definition. Invalid shapes throw (parse-don't-validate).
 * Pure identity continuous trails need only recipeList: ["identity.continuous"].
 */
export function defineTrail(input: TrailDefinitionInput): TrailDefinition {
	if (!input.id || !input.version) {
		throw Object.assign(new TypeError("trail id and version required"), {
			code: "trail-definition-invalid",
		});
	}
	const steps = Object.freeze((input.steps ?? []).map((s) => parseStep(s)));
	const recipeList = Object.freeze([...(input.recipeList ?? [])]);
	if (steps.length === 0 && recipeList.length === 0) {
		throw Object.assign(new TypeError("trail requires steps or recipeList"), {
			code: "trail-definition-empty",
		});
	}
	// Validate dependsOn within steps.
	const ids = new Set(steps.map((s) => s.id));
	for (const s of steps) {
		for (const d of s.dependsOn ?? []) {
			if (!ids.has(d)) {
				throw Object.assign(
					new TypeError(`step ${s.id} depends on missing step ${d}`),
					{ code: "trail-step-dep-missing" },
				);
			}
		}
	}
	const body = {
		schemaVersion: TRAIL_DEFINITION_SCHEMA,
		id: input.id,
		version: input.version,
		description: input.description ?? "",
		targets: Object.freeze([...(input.targets ?? ["*"])]),
		...(input.dependsOnTrails !== undefined
			? { dependsOnTrails: Object.freeze([...input.dependsOnTrails]) }
			: undefined),
		steps,
		...(recipeList.length > 0 ? { recipeList } : undefined),
	};
	const contentHash =
		`sha256:${createHash("sha256").update(stableStringify(body)).digest("hex")}` as const;
	return Object.freeze({
		...body,
		contentHash,
	});
}

function parseStep(s: TrailStep): TrailStep {
	if (!s.id || !s.kind) {
		throw Object.assign(new TypeError("step id and kind required"), {
			code: "trail-step-invalid",
		});
	}
	if (
		s.data?.pattern !== undefined &&
		!TRAIL_DATA_PATTERNS.includes(s.data.pattern)
	) {
		throw Object.assign(
			new TypeError(`step ${s.id} names an unknown migration pattern`),
			{ code: "trail-step-pattern-unknown" },
		);
	}
	// Fail closed: no plaintext secrets in definitions.
	const blob = JSON.stringify(s);
	if (
		/(password|api[_-]?key|private[_-]?key|BEGIN (RSA |EC )?PRIVATE KEY)/i.test(
			blob,
		)
	) {
		throw Object.assign(
			new Error("trail definition must not contain plaintext secrets"),
			{ code: "trail-secret-forbidden" },
		);
	}
	return Object.freeze({
		id: s.id,
		kind: s.kind,
		...(s.description !== undefined
			? { description: s.description }
			: undefined),
		...(s.dependsOn !== undefined
			? { dependsOn: Object.freeze([...s.dependsOn]) }
			: undefined),
		...(s.recipeId !== undefined ? { recipeId: s.recipeId } : undefined),
		...(s.trailRef !== undefined ? { trailRef: s.trailRef } : undefined),
		...(s.schema !== undefined
			? { schema: Object.freeze({ ...s.schema }) }
			: undefined),
		...(s.data !== undefined
			? { data: Object.freeze({ ...s.data }) }
			: undefined),
		...(s.identity !== undefined
			? {
					identity: Object.freeze({
						continuous: true as const,
						bindleConfigRequired: false as const,
						...(s.identity.sourceAdapter !== undefined
							? { sourceAdapter: s.identity.sourceAdapter }
							: undefined),
						...(s.identity.targetAdapter !== undefined
							? { targetAdapter: s.identity.targetAdapter }
							: undefined),
					}),
				}
			: undefined),
		...(s.junction !== undefined
			? { junction: Object.freeze({ ...s.junction }) }
			: undefined),
		...(s.oracleId !== undefined ? { oracleId: s.oracleId } : undefined),
		...(s.progressive !== undefined
			? { progressive: s.progressive }
			: undefined),
	});
}

function stableStringify(value: JsonValue): string {
	if (value === null || (!isJsonObject(value) && !Array.isArray(value))) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj = value;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Ensure validation/cutover never run before dual/schema/data work purely
 * because Kahn sorted free nodes alphabetically. Platform recipes alone do
 * not know app step ids — wire phase edges over the full step set.
 */
export function wireTrailPhaseDependencies(
	steps: readonly TrailStep[],
): readonly TrailStep[] {
	const ids = new Set(steps.map((s) => s.id));
	const workIds = steps
		.filter(
			(s) =>
				s.kind === "schema" ||
				s.kind === "data-transform" ||
				s.kind === "continuous-dual-data" ||
				s.kind === "identity-continuous" ||
				s.kind === "junction-rebind" ||
				s.kind === "secretless-reresolve" ||
				s.kind === "custom" ||
				s.kind === "compose",
		)
		.map((s) => s.id)
		.filter((id) => ids.has(id));
	const validationIds = steps
		.filter((s) => s.kind === "validation")
		.map((s) => s.id);

	return Object.freeze(
		steps.map((s) => {
			if (s.kind === "validation" && workIds.length > 0) {
				const deps = new Set([...(s.dependsOn ?? []), ...workIds]);
				deps.delete(s.id);
				return Object.freeze({
					...s,
					dependsOn: Object.freeze([...deps].sort()),
				});
			}
			if (s.kind === "cutover") {
				const gate = validationIds.length > 0 ? validationIds : workIds;
				if (gate.length === 0) return s;
				const deps = new Set([...(s.dependsOn ?? []), ...gate]);
				deps.delete(s.id);
				return Object.freeze({
					...s,
					dependsOn: Object.freeze([...deps].sort()),
				});
			}
			return s;
		}),
	);
}

/** Topological order of steps (Kahn). Throws on cycles. */
export function orderTrailSteps(
	steps: readonly TrailStep[],
): readonly TrailStep[] {
	// Wire phase edges first so cutover cannot beat dual by alphabetical id.
	const wired = wireTrailPhaseDependencies(steps);
	const byId = new Map(wired.map((s) => [s.id, s]));
	const indeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const s of wired) {
		indeg.set(s.id, 0);
		adj.set(s.id, []);
	}
	for (const s of wired) {
		for (const d of s.dependsOn ?? []) {
			if (!byId.has(d)) {
				throw Object.assign(
					new Error(`step ${s.id} depends on missing step ${d}`),
					{ code: "trail-step-dep-missing" },
				);
			}
			adj.get(d)?.push(s.id);
			indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
		}
	}
	const q = [...indeg.entries()]
		.filter(([, n]) => n === 0)
		.map(([id]) => id)
		.sort();
	const out: TrailStep[] = [];
	while (q.length > 0) {
		// `q.sort()` below re-orders the *remaining* queue, so this has to keep
		// draining from the front; a cursor would sort already-visited entries
		// back into play. `length > 0` does not narrow `shift()`, so guard it.
		const id = q.shift();
		if (id === undefined) break;
		const step = byId.get(id);
		if (step) out.push(step);
		for (const n of adj.get(id) ?? []) {
			const next = (indeg.get(n) ?? 1) - 1;
			indeg.set(n, next);
			if (next === 0) q.push(n);
			q.sort();
		}
	}
	if (out.length !== wired.length) {
		throw Object.assign(new Error("trail steps contain a cycle"), {
			code: "trail-cycle",
		});
	}
	return Object.freeze(out);
}
