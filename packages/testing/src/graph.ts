/**
 * Structural parse of a collected Bindle into the topology the harness boots.
 *
 * The harness takes `bindle: unknown` on purpose: `@hobo/testing` is a layer-3
 * package that must not drag `@hobo/bindles` into every consumer's graph, and
 * ADR-0144's bindle-first rule says an abstract shape beats a concrete import.
 * So this module is the parse boundary — it turns an unknown value into a
 * frozen `TestTopology` (a derived domain type) or throws
 * `HARNESS_BINDLE_INVALID`. Nothing downstream re-checks the shape.
 *
 * Dependency direction follows the collected form: a `BindleEdge` is
 * `{ from, to }` where `from` depends on `to`, matching the resource records'
 * own `dependsOn` lists. Deployment order is dependencies-first with a
 * lexicographic tie-break so the order is deterministic under input
 * permutation; teardown is its exact reverse (ADR-0159 §2b).
 */

import { TestHarnessError } from "./errors.js";
import { isHttpServedKind } from "./fidelity.js";

export interface TestTopologyNode {
	readonly alias: string;
	readonly kind: string;
	/** Aliases inside this topology that `alias` depends on. Sorted, deduped. */
	readonly dependsOn: readonly string[];
	/** The collected graph declared an entrypoint factory for this alias. */
	readonly hasEntrypoint: boolean;
}

export interface TestTopology {
	readonly name: string;
	readonly nodes: readonly TestTopologyNode[];
	/**
	 * Declared dependencies that name something outside the resource set
	 * (connectors, for example). Recorded rather than dropped: a silently
	 * discarded edge is a portability lie.
	 */
	readonly unresolvedDependencies: readonly {
		readonly alias: string;
		readonly dependency: string;
	}[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function entrypointFactory(bindle: Record<string, unknown>, alias: string) {
	const entrypoint = bindle.entrypoint;
	if (typeof entrypoint !== "function") return undefined;
	try {
		const factory = (entrypoint as (name: string) => unknown).call(
			bindle,
			alias,
		);
		return typeof factory === "function" ? factory : undefined;
	} catch {
		return undefined;
	}
}

/** Parse boundary. Returns a frozen derived domain type or throws. */
export function parseTestTopology(bindle: unknown): TestTopology {
	if (!isRecord(bindle)) {
		throw new TestHarnessError(
			"HARNESS_BINDLE_INVALID",
			"the harness was handed a value that is not a collected Bindle definition",
			"pass the object returned by `bindle(...)` from @hobo/bindles (an object with a `resources` record)",
		);
	}
	const resources = bindle.resources;
	if (!isRecord(resources)) {
		throw new TestHarnessError(
			"HARNESS_BINDLE_INVALID",
			"the collected Bindle has no `resources` record",
			"collect the Bindle before handing it to the harness; `definition.resources` must be a record of alias → resource record",
		);
	}

	const aliases = Object.keys(resources).sort();
	const declared = new Map<string, Set<string>>();
	for (const alias of aliases) declared.set(alias, new Set<string>());

	for (const alias of aliases) {
		const record = resources[alias];
		if (!isRecord(record) || typeof record.kind !== "string") {
			throw new TestHarnessError(
				"HARNESS_BINDLE_INVALID",
				`resource "${alias}" has no string \`kind\``,
				"every collected resource record carries `kind`; re-collect the Bindle rather than hand-building the record",
			);
		}
		const bucket = declared.get(alias);
		if (bucket === undefined) continue;
		for (const dependency of stringList(record.dependsOn)) {
			bucket.add(dependency);
		}
	}

	if (Array.isArray(bindle.edges)) {
		for (const edge of bindle.edges) {
			if (!isRecord(edge)) continue;
			const { from, to } = edge;
			if (typeof from !== "string" || typeof to !== "string") continue;
			declared.get(from)?.add(to);
		}
	}

	const unresolved: { readonly alias: string; readonly dependency: string }[] =
		[];
	const nodes: TestTopologyNode[] = [];

	for (const alias of aliases) {
		const record = resources[alias] as Record<string, unknown>;
		const kind = record.kind as string;
		const all = [...(declared.get(alias) ?? new Set<string>())].sort();
		const inside = all.filter((dependency) => declared.has(dependency));
		for (const dependency of all) {
			if (!declared.has(dependency)) unresolved.push({ alias, dependency });
		}
		nodes.push(
			Object.freeze({
				alias,
				kind,
				dependsOn: Object.freeze(inside),
				hasEntrypoint:
					isHttpServedKind(kind) &&
					entrypointFactory(bindle, alias) !== undefined,
			}),
		);
	}

	const name = typeof bindle.name === "string" ? bindle.name : "app";

	return Object.freeze({
		name,
		nodes: Object.freeze(nodes),
		unresolvedDependencies: Object.freeze(
			unresolved.map((entry) => Object.freeze(entry)),
		),
	});
}

/**
 * Dependencies first, lexicographic among the ready set. Deterministic under
 * input permutation; a cycle is refused rather than broken arbitrarily.
 */
export function deploymentOrder(topology: TestTopology): readonly string[] {
	const pending = new Map<string, Set<string>>();
	for (const node of topology.nodes) {
		pending.set(node.alias, new Set(node.dependsOn));
	}

	const ordered: string[] = [];
	while (pending.size > 0) {
		const ready = [...pending.entries()]
			.filter(([, deps]) => deps.size === 0)
			.map(([alias]) => alias)
			.sort();
		if (ready.length === 0) {
			throw new TestHarnessError(
				"HARNESS_CYCLIC_DEPENDENCY",
				`the collected graph has a dependency cycle among: ${[...pending.keys()].sort().join(", ")}`,
				"break the cycle in the Bindle — use `withReference(...)` for a non-ordering edge instead of `dependsOn(...)`",
			);
		}
		for (const alias of ready) {
			ordered.push(alias);
			pending.delete(alias);
		}
		for (const deps of pending.values()) {
			for (const alias of ready) deps.delete(alias);
		}
	}

	return Object.freeze(ordered);
}

/** Exact reverse of `deploymentOrder` — dependents torn down before deps. */
export function teardownOrder(topology: TestTopology): readonly string[] {
	return Object.freeze([...deploymentOrder(topology)].reverse());
}
