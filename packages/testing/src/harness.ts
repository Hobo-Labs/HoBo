import type { Messaging, Queue, SchedulerPort, VirtualClock } from "@hobo/core";
import type { EngineBinding } from "@hobo/data-core";
import type {
	DeliveryPort,
	ExperimentPort,
	FeatureFlagPort,
	SecretsPort,
} from "@hobo/identity";
import type {
	BlobStorePort,
	BucketEmulator,
	BucketInspector,
	FlagEmulator,
	FlagInspector,
	KeyValuePort,
	QueueEmulator,
	ScheduleEmulator,
} from "./emulators.js";
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

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these functions parse the public lane, stage and resource-handle inputs. */
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
		prodReadinessClaimable: false,
	});
}

interface HarnessState {
	readonly graph: DeployedGraph;
	readonly deployment: InProcessDeployment;
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly asserted: Set<string>;
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
	function queueEmulator(alias: string): QueueEmulator {
		const handle = handles.get(alias);
		if (handle === undefined) unknownAlias(alias, aliases);
		asserted.add(alias);
		const emulator = deployment.queues.get(alias);
		if (emulator === undefined) {
			throw new TestHarnessError(
				"HARNESS_EMULATOR_UNAVAILABLE",
				`"${alias}" (kind ${handle.kind}) has no queue emulator`,
				"use the alias of a queue resource in the in-process graph",
			);
		}
		return emulator;
	}
	function scheduleEmulator(alias: string): ScheduleEmulator {
		const handle = handles.get(alias);
		if (handle === undefined) unknownAlias(alias, aliases);
		asserted.add(alias);
		const emulator = deployment.schedules.get(alias);
		if (emulator === undefined) {
			throw new TestHarnessError(
				"HARNESS_EMULATOR_UNAVAILABLE",
				`"${alias}" (kind ${handle.kind}) has no schedule emulator`,
				"use the alias of a schedule resource in the in-process graph",
			);
		}
		return emulator;
	}
	function bucketEmulator(alias: string): BucketEmulator {
		const handle = handles.get(alias);
		if (handle === undefined) unknownAlias(alias, aliases);
		asserted.add(alias);
		const emulator = deployment.buckets.get(alias);
		if (emulator === undefined) {
			throw new TestHarnessError(
				"HARNESS_EMULATOR_UNAVAILABLE",
				`"${alias}" (kind ${handle.kind}) has no bucket emulator`,
				"use the alias of a bucket resource in the in-process graph",
			);
		}
		return emulator;
	}
	function flagEmulator(alias: string): FlagEmulator {
		const handle = handles.get(alias);
		if (handle === undefined) unknownAlias(alias, aliases);
		asserted.add(alias);
		const emulator = deployment.flags.get(alias);
		if (emulator === undefined) {
			throw new TestHarnessError(
				"HARNESS_EMULATOR_UNAVAILABLE",
				`"${alias}" (kind ${handle.kind}) has no flag emulator`,
				"use the alias of a flag resource in the in-process graph",
			);
		}
		return emulator;
	}
	return Object.freeze({
		stage,
		lane,
		// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: this preserves the existing caller-typed open binding map.
		outputs<T = Record<string, unknown>>(): T {
			// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: each value comes from the parsed deployment bindings.
			const record: Record<string, unknown> = {};
			for (const alias of aliases) {
				asserted.add(alias);
				record[alias] = deployment.bindings[alias];
			}
			// SAFETY: the caller selects the existing generic outputs view.
			return Object.freeze(record) as T;
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
		queue(alias: string): Queue {
			return queueEmulator(alias).port;
		},
		queueClock(alias: string): VirtualClock | undefined {
			return queueEmulator(alias).clock;
		},
		topic(alias: string): Messaging {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			const emulator = deployment.topics.get(alias);
			if (emulator === undefined) {
				throw new TestHarnessError(
					"HARNESS_EMULATOR_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}) has no topic emulator`,
					"use the alias of a topic resource in the in-process graph",
				);
			}
			return emulator.port;
		},
		secret(alias: string): SecretsPort {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			const emulator = deployment.secrets.get(alias);
			if (emulator === undefined) {
				throw new TestHarnessError(
					"HARNESS_EMULATOR_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}) has no secret emulator`,
					"use the alias of a secret resource in the in-process graph",
				);
			}
			return emulator.port;
		},
		data(alias: string): EngineBinding {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			const emulator = deployment.data.get(alias);
			if (emulator === undefined) {
				throw new TestHarnessError(
					"HARNESS_EMULATOR_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}) has no data emulator`,
					"use the alias of a data resource in the in-process graph",
				);
			}
			return emulator.port;
		},
		schedule(alias: string): SchedulerPort {
			return scheduleEmulator(alias).port;
		},
		scheduleClock(alias: string): VirtualClock | undefined {
			return scheduleEmulator(alias).clock;
		},
		kv(alias: string): KeyValuePort {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			const emulator = deployment.kv.get(alias);
			if (emulator === undefined) {
				throw new TestHarnessError(
					"HARNESS_EMULATOR_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}) has no key-value emulator`,
					"use the alias of a kv resource in the in-process graph",
				);
			}
			return emulator.port;
		},
		bucket(alias: string): BlobStorePort {
			return bucketEmulator(alias).port;
		},
		flag(alias: string): FeatureFlagPort {
			return flagEmulator(alias).port;
		},
		rollout(alias: string): DeliveryPort {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			const emulator = deployment.rollouts.get(alias);
			if (emulator === undefined) {
				throw new TestHarnessError(
					"HARNESS_EMULATOR_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}) has no rollout emulator`,
					"use the alias of a rollout resource in the in-process graph",
				);
			}
			return emulator.port;
		},
		experiment(alias: string): ExperimentPort {
			const handle = handles.get(alias);
			if (handle === undefined) unknownAlias(alias, aliases);
			asserted.add(alias);
			const emulator = deployment.experiments.get(alias);
			if (emulator === undefined) {
				throw new TestHarnessError(
					"HARNESS_EMULATOR_UNAVAILABLE",
					`"${alias}" (kind ${handle.kind}) has no experiment emulator`,
					"use the alias of an experiment resource in the in-process graph",
				);
			}
			return emulator.port;
		},
		flagInspector(alias: string): FlagInspector | undefined {
			return flagEmulator(alias).inspector;
		},
		bucketInspector(alias: string): BucketInspector | undefined {
			return bucketEmulator(alias).inspector;
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
}

/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: Bindle identities are accepted at the public boundary and parsed by deployInProcess before use. */
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
	const states = new Map<unknown, Promise<HarnessState>>();
	const destroying = new Map<unknown, Set<Promise<void>>>();
	let latest: HarnessState | undefined;

	async function ensure(bindle: unknown): Promise<HarnessState> {
		const existing = states.get(bindle);
		if (existing !== undefined) return existing;
		const pending = (async (): Promise<HarnessState> => {
			if (campTarget !== undefined) await deployEphemeralCamp(campTarget);
			const deployment = await deployInProcess(
				bindle,
				stage,
				options.emulators,
			);
			const asserted = new Set<string>();
			const state: HarnessState = {
				graph: buildGraph(stage, lane, deployment, asserted),
				deployment,
				handles: deployment.handles,
				asserted,
			};
			return state;
		})();
		states.set(bindle, pending);
		try {
			const state = await pending;
			if (states.get(bindle) === pending) latest = state;
			return state;
		} catch (cause) {
			if (states.get(bindle) === pending) states.delete(bindle);
			throw cause;
		}
	}

	return Object.freeze({
		deploy(bindle: unknown): () => Promise<DeployedGraph> {
			return async () => (await ensure(bindle)).graph;
		},
		destroy(bindle: unknown): () => Promise<void> {
			return async () => {
				const pending = states.get(bindle);
				if (pending !== undefined) {
					states.delete(bindle);
					const cleanups = destroying.get(bindle) ?? new Set<Promise<void>>();
					destroying.set(bindle, cleanups);
					const cleanup = (async () => {
						const state = await pending;
						if (latest === state) latest = undefined;
						await destroyInProcess(state.deployment);
					})();
					cleanups.add(cleanup);
					try {
						await cleanup;
					} finally {
						cleanups.delete(cleanup);
						if (cleanups.size === 0) destroying.delete(bindle);
					}
				}
				await Promise.all(destroying.get(bindle) ?? []);
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
/* oxlint-enable anti-slop/no-unknown-parameters */

/**
 * The two-line runner swap's payoff: wire deploy/destroy into whichever
 * runner's lifecycle hooks the suite is using.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: runner hook return values are deliberately ignored; Bindle validation occurs on deploy. */
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
