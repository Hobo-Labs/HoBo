import { AsyncLocalStorage } from "node:async_hooks";
import type {
	JsonObject,
	JsonValue,
	Messaging,
	Queue,
	SchedulerPort,
	VirtualClock,
} from "@hobo/core";
import type { EngineBinding } from "@hobo/data-core";
import type {
	DeliveryPort,
	ExperimentPort,
	FeatureFlagPort,
	SecretsPort,
} from "@hobo/identity";
import {
	assertNotInScheduleHandler,
	type BlobStorePort,
	type BucketEmulator,
	type BucketInspector,
	type FlagEmulator,
	type FlagInspector,
	type KeyValuePort,
	type QueueEmulator,
	type ScheduleDriver,
	type ScheduleEmulator,
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
	readonly deployment: HarnessDeployment;
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly asserted: Set<string>;
}

type HarnessDeployment = Pick<
	InProcessDeployment,
	| "handles"
	| "queues"
	| "topics"
	| "secrets"
	| "data"
	| "schedules"
	| "kv"
	| "buckets"
	| "flags"
	| "rollouts"
	| "experiments"
> & {
	readonly outputs: JsonObject;
	destroy(): Promise<void>;
};

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
		outputs<T extends JsonObject = JsonObject>(): T {
			const outputs: Record<string, JsonValue> = {};
			for (const alias of aliases) {
				asserted.add(alias);
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
		scheduleDriver(alias: string): ScheduleDriver | undefined {
			return scheduleEmulator(alias).driver;
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
	readonly probe?: ReadinessProbe;
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

	if (options.runner !== undefined) parseRunnerAdapter(options.runner);
	else requireRunner(env);

	const campTarget =
		lane === "ephemeral-camp"
			? parseEphemeralCampTarget(options.yard, env)
			: undefined;

	const probe = internals.probe ?? createFetchReadinessProbe();
	const states = new Map<BindleInput, Promise<HarnessState>>();
	const destroying = new Map<BindleInput, Set<Promise<void>>>();
	const deployments = new Map<BindleInput, Set<HarnessDeployment>>();
	const deploying = new AsyncLocalStorage<{
		bindle: BindleInput;
		active: boolean;
	}>();
	let latest: HarnessState | undefined;

	async function deployLane(bindle: BindleInput): Promise<HarnessDeployment> {
		if (campTarget !== undefined) {
			const camp = await deployEphemeralCamp(
				campTarget,
				bindle,
				stage,
				options.campDriver,
			);
			return Object.freeze({
				handles: camp.handles,
				outputs: camp.outputs,
				queues: new Map(),
				topics: new Map(),
				secrets: new Map(),
				data: new Map(),
				schedules: new Map(),
				kv: new Map(),
				buckets: new Map(),
				flags: new Map(),
				rollouts: new Map(),
				experiments: new Map(),
				destroy: () => camp.destroy(),
			});
		}
		const deployment = await deployInProcess(bindle, stage, options.emulators);
		return Object.freeze({
			handles: deployment.handles,
			outputs: deployment.bindings,
			queues: deployment.queues,
			topics: deployment.topics,
			secrets: deployment.secrets,
			data: deployment.data,
			schedules: deployment.schedules,
			kv: deployment.kv,
			buckets: deployment.buckets,
			flags: deployment.flags,
			rollouts: deployment.rollouts,
			experiments: deployment.experiments,
			async destroy(): Promise<void> {
				await destroyInProcess(deployment);
			},
		});
	}

	async function ensure(bindle: BindleInput): Promise<HarnessState> {
		const existing = states.get(bindle);
		if (existing !== undefined) return existing;
		const pending = (async (): Promise<HarnessState> => {
			const frame = { bindle, active: true };
			let deployment: HarnessDeployment;
			try {
				deployment = await deploying.run(frame, () => deployLane(bindle));
			} finally {
				frame.active = false;
			}
			const activeDeployments = deployments.get(bindle) ?? new Set();
			activeDeployments.add(deployment);
			deployments.set(bindle, activeDeployments);
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
		deploy(bindle: BindleInput): () => Promise<DeployedGraph> {
			return async () => (await ensure(bindle)).graph;
		},
		destroy(bindle: BindleInput): () => Promise<void> {
			return async () => {
				const frame = deploying.getStore();
				if (frame?.active && frame.bindle === bindle)
					throw new Error(
						"A graph cannot be destroyed from its own deployment.",
					);
				for (const deployment of deployments.get(bindle) ?? [])
					assertNotInScheduleHandler(deployment.schedules.values());
				const pending = states.get(bindle);
				if (pending !== undefined) {
					states.delete(bindle);
					const cleanups = destroying.get(bindle) ?? new Set<Promise<void>>();
					destroying.set(bindle, cleanups);
					const cleanup = (async () => {
						const state = await pending;
						if (latest === state) latest = undefined;
						try {
							await state.deployment.destroy();
						} finally {
							const activeDeployments = deployments.get(bindle);
							activeDeployments?.delete(state.deployment);
							if (activeDeployments?.size === 0) deployments.delete(bindle);
						}
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

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: runner hook return values are deliberately ignored; Bindle validation occurs on deploy. */
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
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
