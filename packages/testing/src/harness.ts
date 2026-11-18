/**
 * `createTestHarness` — the out-of-box app harness (ADR-0159, GAP-026).
 *
 * Deploy the collected topology, assert against it, tear it down. The surface
 * is plain async/await and typed results: no Effect-TS, no Polly, no XState on
 * the public surface (ADR-0136).
 *
 * Two decisions here carry the unit's honesty:
 *
 * 1. Lane selection is fail-closed. `in-process` is the default; choosing
 *    `ephemeral-camp` runs its gates at construction so an author learns about
 *    a missing Yard or credential before writing assertions, and the lane
 *    never silently becomes `in-process`.
 * 2. `fidelity()` counts what the suite actually reached for. Obtaining a
 *    handle through `resource(alias)`, `http(alias)`, or `untilReady(alias)`
 *    marks it asserted-against; if any of those handles is `mocked`, this run
 *    cannot claim prod-readiness and the report says so.
 */

import { TestHarnessError } from "./errors.js";
import { emptyFidelityCounts } from "./fidelity.js";
import {
	deployEphemeralCamp,
	parseEphemeralCampTarget,
} from "./lanes/ephemeral-camp.js";
import {
	deployInProcess,
	destroyInProcess,
	type InProcessDeployment,
	InProcessStartupCleanupError,
} from "./lanes/in-process.js";
import {
	createFetchReadinessProbe,
	type ReadinessProbe,
	type UntilReadyOptions,
	untilReadyWith,
} from "./readiness.js";
import { parseRunnerAdapter, requireRunner } from "./runner.js";
import {
	DEFAULT_LANE,
	DEFAULT_STAGE,
	type DeployedGraph,
	type FidelityReport,
	LANES,
	type Lane,
	type ResourceHandle,
	type TestHarness,
	type TestHarnessOptions,
} from "./types.js";

const STAGE_PATTERN = /^[a-z][a-z0-9-]*$/u;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these existing boundary helpers inspect untyped runtime inputs before using their lane, stage, or handle fields. */
function parseLane(value: unknown): Lane {
	if (value === undefined) return DEFAULT_LANE;
	if (typeof value !== "string" || !LANES.includes(value)) {
		throw new TestHarnessError(
			"HARNESS_LANE_INVALID",
			`unknown harness lane ${JSON.stringify(value)}`,
			`use one of: ${LANES.join(", ")}`,
		);
	}
	return value as Lane;
}

function parseStage(value: unknown): string {
	if (value === undefined) return DEFAULT_STAGE;
	if (typeof value !== "string" || !STAGE_PATTERN.test(value)) {
		throw new TestHarnessError(
			"HARNESS_STAGE_INVALID",
			`stage ${JSON.stringify(value)} is not a lowercase slug`,
			'use a lowercase slug such as "test" or "pr-42" — stages are Camp names, not free text',
		);
	}
	return value;
}

function isResourceHandle(value: unknown): value is ResourceHandle {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ResourceHandle).alias === "string" &&
		typeof (value as ResourceHandle).fidelity === "string"
	);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */

function buildFidelityReport(
	handles: ReadonlyMap<string, ResourceHandle>,
	asserted: ReadonlySet<string>,
): FidelityReport {
	const byFidelity = emptyFidelityCounts();
	for (const handle of handles.values()) {
		byFidelity[handle.fidelity] += 1;
	}
	const assertedAgainst = [...asserted].sort().flatMap((alias) => {
		const handle = handles.get(alias);
		return handle === undefined
			? []
			: [Object.freeze({ alias, fidelity: handle.fidelity })];
	});
	return Object.freeze({
		byFidelity: Object.freeze(byFidelity),
		assertedAgainst: Object.freeze(assertedAgainst),
		prodReadinessClaimable: assertedAgainst.every(
			(entry) => entry.fidelity !== "mocked",
		),
	});
}

interface HarnessState {
	readonly graph: DeployedGraph;
	readonly deployment: InProcessDeployment;
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly asserted: Set<string>;
}

interface HarnessEntry {
	readonly state: Promise<HarnessState>;
	closing?: Promise<void>;
	closeFailure?: { readonly cause: unknown };
}

function unknownAlias(alias: string, known: readonly string[]): never {
	throw new TestHarnessError(
		"HARNESS_ALIAS_UNKNOWN",
		`no resource named "${alias}" in the deployed graph`,
		known.length === 0
			? "deploy the Bindle first — `await harness.deploy(bindle)()` — then look the alias up"
			: `use one of the collected aliases: ${known.join(", ")}`,
	);
}

function buildGraph(
	stage: string,
	lane: Lane,
	deployment: InProcessDeployment,
	asserted: Set<string>,
): DeployedGraph {
	const handles = deployment.handles;
	const aliases = [...handles.keys()].sort();
	return Object.freeze({
		stage,
		lane,
		/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the existing outputs contract lets its caller choose the expected binding type. */
		outputs<T = Record<string, unknown>>(): T {
			const record: Record<string, unknown> = {};
			for (const alias of aliases) {
				record[alias] = deployment.bindings[alias];
			}
			return Object.freeze(record) as T;
		},
		/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion */
		resource(alias: string): ResourceHandle {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			return handle;
		},
		http(alias: string): { readonly baseUrl: string } {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			if (handle.endpoint === undefined) {
				throw new TestHarnessError(
					"HARNESS_ENDPOINT_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}, fidelity ${handle.fidelity}) has no HTTP endpoint in this lane`,
					"the in-process lane only opens listeners for HTTP-shaped resources whose collected entrypoint resolves to a fetch handler; give the resource an entrypoint or assert against it through resource(alias)",
				);
			}
			return Object.freeze({ baseUrl: handle.endpoint });
		},
		fidelity(): FidelityReport {
			return buildFidelityReport(handles, asserted);
		},
	});
}

export interface CreateTestHarnessInternals {
	/** Injectable readiness probe; defaults to the platform `fetch`. */
	readonly probe?: ReadinessProbe;
	/** Injectable environment for the ephemeral-camp credential gate. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Injectable in-process lane for testing lifecycle coordination. */
	readonly deployInProcess?: typeof deployInProcess;
	readonly destroyInProcess?: typeof destroyInProcess;
}

export function createTestHarness(
	options: TestHarnessOptions = {},
	internals: CreateTestHarnessInternals = {},
): TestHarness {
	const lane = parseLane(options.lane);
	const stage = parseStage(options.stage);
	const env = internals.env ?? process.env;

	// A supplied adapter is parsed; otherwise the active runner must be
	// detectable. Guessing hook names produces a suite that never deploys.
	if (options.runner !== undefined) parseRunnerAdapter(options.runner);
	else requireRunner(env);

	const campTarget =
		lane === "ephemeral-camp"
			? parseEphemeralCampTarget(options.yard, env)
			: undefined;

	const probe = internals.probe ?? createFetchReadinessProbe();
	const deployLane = internals.deployInProcess ?? deployInProcess;
	const destroyLane = internals.destroyInProcess ?? destroyInProcess;
	const states = new Map<unknown, HarnessEntry>();
	let latest: HarnessState | undefined;

	/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: the public harness accepts an opaque bindle identity; the lane validates its topology before using it. */
	async function ensure(bindle: unknown): Promise<HarnessState> {
		const existing = states.get(bindle);
		if (existing?.closing !== undefined) {
			await existing.closing;
			return ensure(bindle);
		}
		if (existing?.closeFailure !== undefined) throw existing.closeFailure.cause;
		if (existing !== undefined) return existing.state;
		// Publish the entry before invoking user-provided topology or entrypoints.
		const pending = Promise.resolve().then(async (): Promise<HarnessState> => {
			if (campTarget !== undefined) await deployEphemeralCamp(campTarget);
			const deployment = await deployLane(bindle, stage);
			const asserted = new Set<string>();
			const state: HarnessState = {
				graph: buildGraph(stage, lane, deployment, asserted),
				deployment,
				handles: deployment.handles,
				asserted,
			};
			latest = state;
			return state;
		});
		const entry: HarnessEntry = { state: pending };
		states.set(bindle, entry);
		try {
			return await pending;
		} catch (cause) {
			if (cause instanceof InProcessStartupCleanupError) {
				entry.closeFailure = { cause };
			} else if (states.get(bindle) === entry && entry.closing === undefined) {
				states.delete(bindle);
			}
			throw cause;
		}
	}

	return Object.freeze({
		deploy(bindle: unknown): () => Promise<DeployedGraph> {
			return async () => (await ensure(bindle)).graph;
		},
		destroy(bindle: unknown): () => Promise<void> {
			return async () => {
				const entry = states.get(bindle);
				if (entry === undefined) return;
				if (entry.closing !== undefined) return entry.closing;
				const closing = (async (): Promise<void> => {
					let state: HarnessState;
					try {
						state = await entry.state;
					} catch (cause) {
						if (cause instanceof InProcessStartupCleanupError) {
							try {
								await cause.retryCleanup();
							} catch (cleanupCause) {
								entry.closeFailure = { cause: cleanupCause };
								throw cleanupCause;
							}
							if (states.get(bindle) === entry) states.delete(bindle);
							return;
						}
						if (states.get(bindle) === entry) states.delete(bindle);
						throw cause;
					}
					if (latest === state) latest = undefined;
					try {
						await destroyLane(state.deployment);
					} catch (cause) {
						entry.closeFailure = { cause };
						throw cause;
					}
					if (states.get(bindle) === entry) states.delete(bindle);
				})();
				entry.closing = closing;
				try {
					await closing;
				} finally {
					if (entry.closing === closing) delete entry.closing;
				}
			};
		},
		async untilReady(
			target: string | ResourceHandle,
			readyOptions?: UntilReadyOptions,
		): Promise<{ readonly status: number }> {
			return untilReadyWith(probe, resolveTarget(target), readyOptions ?? {});
		},
	});

	function resolveTarget(target: string | ResourceHandle): string {
		if (isResourceHandle(target)) {
			latest?.asserted.add(target.alias);
			if (target.endpoint === undefined) {
				throw new TestHarnessError(
					"HARNESS_ENDPOINT_UNAVAILABLE",
					`handle "${target.alias}" (fidelity ${target.fidelity}) carries no endpoint to poll`,
					"poll a handle that was served — in the in-process lane that means an HTTP-shaped resource with a resolved entrypoint",
				);
			}
			return target.endpoint;
		}
		if (/^https?:\/\//u.test(target)) return target;
		if (latest === undefined) {
			throw new TestHarnessError(
				"HARNESS_ALIAS_UNKNOWN",
				`untilReady("${target}") was called before anything was deployed`,
				"await `harness.deploy(bindle)()` first, or pass an absolute http(s) URL",
			);
		}
		return latest.graph.http(target).baseUrl;
	}
	/* oxlint-enable anti-slop/no-unknown-parameters */
}

/**
 * The two-line runner swap's payoff: wire deploy/destroy into whichever
 * runner's lifecycle hooks the suite is using.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: this existing adapter forwards an opaque bindle and ignores the runner hook return values. */
export function bindHarnessLifecycle(
	runner: {
		readonly beforeAll: (fn: () => Promise<void>) => unknown;
		readonly afterAll: (fn: () => Promise<void>) => unknown;
	},
	harness: TestHarness,
	bindle: unknown,
): void {
	const deploy = harness.deploy(bindle);
	const destroy = harness.destroy(bindle);
	runner.beforeAll(async () => {
		await deploy();
	});
	runner.afterAll(async () => {
		await destroy();
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
