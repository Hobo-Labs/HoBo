import type { JsonObject, JsonValue } from "@hobo/core";
import { TestHarnessError } from "./errors.js";
import { emptyFidelityCounts } from "./fidelity.js";
import {
	deployEphemeralCamp,
	parseEphemeralCampTarget,
} from "./lanes/ephemeral-camp.js";
import { deployInProcess, destroyInProcess } from "./lanes/in-process.js";
import {
	createFetchReadinessProbe,
	type ReadinessProbe,
	type UntilReadyOptions,
	untilReadyWith,
} from "./readiness.js";
import { parseRunnerAdapter, requireRunner } from "./runner.js";
import {
	type BindleInput,
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

function parseLane(value: Lane | undefined): Lane {
	if (value === undefined) return DEFAULT_LANE;
	if (!LANES.includes(value)) {
		throw new TestHarnessError(
			"HARNESS_LANE_INVALID",
			`unknown harness lane ${JSON.stringify(value)}`,
			`use one of: ${LANES.join(", ")}`,
		);
	}
	return value as Lane;
}

function parseStage(value: string | undefined): string {
	if (value === undefined) return DEFAULT_STAGE;
	if (!STAGE_PATTERN.test(value)) {
		throw new TestHarnessError(
			"HARNESS_STAGE_INVALID",
			`stage ${JSON.stringify(value)} is not a lowercase slug`,
			'use a lowercase slug such as "test" or "pr-42" — stages are Camp names, not free text',
		);
	}
	return value;
}

function isResourceHandle(
	value: string | ResourceHandle,
): value is ResourceHandle {
	return Object(value) === value;
}

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
	readonly deployment: HarnessDeployment;
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly asserted: Set<string>;
}

interface HarnessDeployment {
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly outputs: JsonObject;
	destroy(): Promise<void>;
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
	deployment: HarnessDeployment,
	asserted: Set<string>,
): DeployedGraph {
	const handles = deployment.handles;
	const aliases = [...handles.keys()].sort();
	return Object.freeze({
		stage,
		lane,
		outputs<T extends JsonObject = JsonObject>(): T {
			const outputs: Record<string, JsonValue> = {};
			for (const alias of aliases) {
				const output = deployment.outputs[alias];
				if (output !== undefined) outputs[alias] = output;
			}
			return Object.freeze(outputs) as T;
		},
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
	readonly probe?: ReadinessProbe;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createTestHarness(
	options: TestHarnessOptions = {},
	internals: CreateTestHarnessInternals = {},
): TestHarness {
	const lane = parseLane(options.lane);
	const stage = parseStage(options.stage);
	const env = internals.env ?? process.env;

	if (options.runner !== undefined) parseRunnerAdapter(options.runner);
	else requireRunner(env);

	const campTarget =
		lane === "ephemeral-camp"
			? parseEphemeralCampTarget(options.yard, env)
			: undefined;

	const probe = internals.probe ?? createFetchReadinessProbe();
	const states = new Map<BindleInput, Promise<HarnessState>>();
	let latest: HarnessState | undefined;

	async function deployLane(bindle: BindleInput): Promise<HarnessDeployment> {
		if (campTarget !== undefined) {
			return deployEphemeralCamp(campTarget, bindle, stage, options.campDriver);
		}
		const deployment = await deployInProcess(bindle, stage);
		return Object.freeze({
			handles: deployment.handles,
			outputs: deployment.bindings,
			async destroy(): Promise<void> {
				await destroyInProcess(deployment);
			},
		});
	}

	async function ensure(bindle: BindleInput): Promise<HarnessState> {
		const existing = states.get(bindle);
		if (existing !== undefined) return existing;
		const pending = (async (): Promise<HarnessState> => {
			const deployment = await deployLane(bindle);
			const asserted = new Set<string>();
			const state: HarnessState = {
				graph: buildGraph(stage, lane, deployment, asserted),
				deployment,
				handles: deployment.handles,
				asserted,
			};
			latest = state;
			return state;
		})();
		states.set(bindle, pending);
		try {
			return await pending;
		} catch (cause) {
			states.delete(bindle);
			throw cause;
		}
	}

	return Object.freeze({
		deploy(bindle: BindleInput): () => Promise<DeployedGraph> {
			return async () => (await ensure(bindle)).graph;
		},
		destroy(bindle: BindleInput): () => Promise<void> {
			return async () => {
				const pending = states.get(bindle);
				if (pending === undefined) return;
				states.delete(bindle);
				const state = await pending;
				if (latest === state) latest = undefined;
				await state.deployment.destroy();
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
}

export function bindHarnessLifecycle(
	runner: {
		readonly beforeAll: (fn: () => Promise<void>) => void;
		readonly afterAll: (fn: () => Promise<void>) => void;
	},
	harness: TestHarness,
	bindle: BindleInput,
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
