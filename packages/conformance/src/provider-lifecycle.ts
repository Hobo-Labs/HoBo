import {
	cloneAsJson,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { ConformanceSuiteDescriptor } from "./types.js";

// public-contract: stable suite identifier used in reports and registries.
export const PROVIDER_LIFECYCLE_SUITE_ID =
	"hobo.conformance.provider-lifecycle/v1";

export const PROVIDER_LIFECYCLE_CASE_NAMES = {
	create: "provider-lifecycle/create",
	updateInPlace: "provider-lifecycle/update-in-place",
	replace: "provider-lifecycle/replace",
	deleteIdempotent: "provider-lifecycle/delete-idempotent",
	adopt: "provider-lifecycle/adopt",
	crashResume: "provider-lifecycle/crash-resume-idempotency",
} as const;

export type ProviderLifecycleCaseName =
	(typeof PROVIDER_LIFECYCLE_CASE_NAMES)[keyof typeof PROVIDER_LIFECYCLE_CASE_NAMES];

export const PROVIDER_LIFECYCLE_ERROR_CODES = [
	"SCRATCH_DESIRED_INVALID",
	"SCRATCH_SEED_INVALID",
	"SCRATCH_PROVIDER_INVALID",
	"SCRATCH_ADOPT_UNSUPPORTED",
	"LIFECYCLE_ASSERTION_FAILED",
] as const;

export type ProviderLifecycleErrorCode =
	(typeof PROVIDER_LIFECYCLE_ERROR_CODES)[number];

export class ProviderLifecycleError extends Error {
	readonly code: ProviderLifecycleErrorCode;

	constructor(code: ProviderLifecycleErrorCode, message: string) {
		super(message);
		this.name = "ProviderLifecycleError";
		this.code = code;
	}
}

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ScratchResource {
	readonly id: string;
	readonly type: string;
	readonly logicalId: string;
	readonly owned: boolean;
	readonly outputs: JsonObject;
	readonly stables: JsonObject;
}

export interface ScratchWorld {
	list(): readonly ScratchResource[];
	get(instanceId: string): ScratchResource | undefined;
	find(logicalId: string): ScratchResource | undefined;
	put(resource: ScratchResource): ScratchResource;
	remove(instanceId: string): boolean;
	nextInstanceId(logicalId: string): string;
}

export interface ScratchProviderContext {
	readonly world: ScratchWorld;
	readonly type: string;
	readonly logicalId: string;
	readonly properties: JsonObject;
	readonly stables: JsonObject;
	readonly current?: ScratchResource;
}

export interface ScratchOwnedContext extends ScratchProviderContext {
	readonly current: ScratchResource;
}

export interface ScratchProviderResult {
	readonly instanceId: string;
	readonly outputs: JsonObject;
}

export interface ScratchProvider {
	create(
		context: ScratchProviderContext,
	): ScratchProviderResult | Promise<ScratchProviderResult>;
	update(
		context: ScratchOwnedContext,
	): ScratchProviderResult | Promise<ScratchProviderResult>;
	delete(context: ScratchOwnedContext): void | Promise<void>;
	adopt?(
		context: ScratchOwnedContext,
	): ScratchProviderResult | Promise<ScratchProviderResult>;
}

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ScratchDesired {
	readonly type: string;
	readonly logicalId: string;
	readonly properties: JsonObject;
	readonly stables: JsonObject;
}

export interface ScratchStackState {
	list(): readonly { readonly id: string; readonly type: string }[];
	resources(): readonly ScratchResource[];
}

export interface ScratchStack {
	deploy(desired: ScratchDesired): Promise<{
		readonly outputs: JsonObject;
		readonly instanceId: string;
	}>;
	destroy(): Promise<void>;
	readonly state: ScratchStackState;
}

export interface ScratchSeedResourceInput {
	readonly id: string;
	readonly type: string;
	readonly logicalId: string;
	readonly owned?: boolean;
	readonly outputs?: JsonObject;
	readonly stables?: JsonObject;
}

export interface ScratchSeedInput {
	readonly resources?: readonly ScratchSeedResourceInput[];
}

export interface CreateScratchStackOptions {
	readonly seed?: ScratchSeedInput;
	readonly provider?: ScratchProvider;
}

export interface ProviderLifecycleCase {
	readonly name: string;
	readonly run: (stack: ScratchStack) => Promise<void>;
	readonly seed?: ScratchSeedInput;
}

export interface ProviderLifecycleFailure {
	readonly name: string;
	readonly error: string;
}

export interface ProviderLifecycleResult {
	readonly passed: number;
	readonly failed: readonly ProviderLifecycleFailure[];
}

const SUBJECT_TYPE = "scratch:resource";
const SUBJECT_LOGICAL_ID = "conformance-subject";
const FOREIGN_INSTANCE_ID = "scratch:foreign/pre-existing";

const BASE_DESIRED: ScratchDesired = Object.freeze({
	type: SUBJECT_TYPE,
	logicalId: SUBJECT_LOGICAL_ID,
	properties: Object.freeze({ label: "alpha", size: "small" }),
	stables: Object.freeze({ region: "scratch-east" }),
});

const ADOPT_SEED: ScratchSeedInput = Object.freeze({
	resources: Object.freeze([
		Object.freeze({
			id: FOREIGN_INSTANCE_ID,
			type: SUBJECT_TYPE,
			logicalId: SUBJECT_LOGICAL_ID,
			owned: false,
			outputs: Object.freeze({ endpoint: "scratch://foreign" }),
			stables: Object.freeze({ region: "scratch-east" }),
		}),
	]),
});

function compareText(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	return left > right ? 1 : 0;
}

function canonicalize(value: JsonValue | undefined): JsonValue {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value !== null && isJsonObject(value)) {
		const source = value;
		const canonical: JsonBag = {};
		for (const key of Object.keys(source).sort(compareText)) {
			canonical[key] = canonicalize(source[key]);
		}
		return canonical;
	}
	return value ?? null;
}

function canonicalJson<T>(value: T): string {
	return JSON.stringify(canonicalize(cloneAsJson(value)));
}

function messageOf<T>(error: T): string {
	return error instanceof Error ? error.message : String(error);
}

function requireRecord<T>(
	value: T,
	code: ProviderLifecycleErrorCode,
	field: string,
): JsonObject {
	if (value === null || !isJsonObject(value) || Array.isArray(value)) {
		throw new ProviderLifecycleError(code, `${field} must be an object`);
	}
	return value as JsonObject;
}

function requireText<T>(
	value: T,
	code: ProviderLifecycleErrorCode,
	field: string,
): string {
	if (!isJsonString(value) || value.trim().length === 0) {
		throw new ProviderLifecycleError(
			code,
			`${field} must be a non-empty string`,
		);
	}
	return value;
}

function optionalRecord<T>(
	value: T,
	code: ProviderLifecycleErrorCode,
	field: string,
): JsonObject {
	if (value === undefined) {
		return Object.freeze({});
	}
	return Object.freeze({ ...requireRecord(value, code, field) });
}

export function parseScratchDesired<T>(value: T): ScratchDesired {
	const record = requireRecord(value, "SCRATCH_DESIRED_INVALID", "desired");
	return Object.freeze({
		type: requireText(record.type, "SCRATCH_DESIRED_INVALID", "desired.type"),
		logicalId: requireText(
			record.logicalId,
			"SCRATCH_DESIRED_INVALID",
			"desired.logicalId",
		),
		properties: optionalRecord(
			record.properties,
			"SCRATCH_DESIRED_INVALID",
			"desired.properties",
		),
		stables: optionalRecord(
			record.stables,
			"SCRATCH_DESIRED_INVALID",
			"desired.stables",
		),
	});
}

export function parseScratchSeed<T>(value: T): readonly ScratchResource[] {
	if (value === undefined) {
		return Object.freeze([]);
	}
	const record = requireRecord(value, "SCRATCH_SEED_INVALID", "seed");
	if (record.resources === undefined) {
		return Object.freeze([]);
	}
	if (!Array.isArray(record.resources)) {
		throw new ProviderLifecycleError(
			"SCRATCH_SEED_INVALID",
			"seed.resources must be an array",
		);
	}
	const resources = record.resources.map((entry, index) => {
		const field = `seed.resources[${index}]`;
		const seeded = requireRecord(entry, "SCRATCH_SEED_INVALID", field);
		if (seeded.owned !== undefined && !isJsonBoolean(seeded.owned)) {
			throw new ProviderLifecycleError(
				"SCRATCH_SEED_INVALID",
				`${field}.owned must be a boolean`,
			);
		}
		return Object.freeze({
			id: requireText(seeded.id, "SCRATCH_SEED_INVALID", `${field}.id`),
			type: requireText(seeded.type, "SCRATCH_SEED_INVALID", `${field}.type`),
			logicalId: requireText(
				seeded.logicalId,
				"SCRATCH_SEED_INVALID",
				`${field}.logicalId`,
			),
			owned: seeded.owned === true,
			outputs: optionalRecord(
				seeded.outputs,
				"SCRATCH_SEED_INVALID",
				`${field}.outputs`,
			),
			stables: optionalRecord(
				seeded.stables,
				"SCRATCH_SEED_INVALID",
				`${field}.stables`,
			),
		});
	});
	return Object.freeze(resources);
}

export function parseScratchProvider<T>(value: T): ScratchProvider {
	const record = requireRecord(
		value,
		"SCRATCH_PROVIDER_INVALID",
		"provider",
	) as JsonObject;
	for (const verb of ["create", "update", "delete"] as const) {
		if (!(record[verb] instanceof Function)) {
			throw new ProviderLifecycleError(
				"SCRATCH_PROVIDER_INVALID",
				`provider.${verb} must be a function`,
			);
		}
	}
	if (record.adopt !== undefined && !(record.adopt instanceof Function)) {
		throw new ProviderLifecycleError(
			"SCRATCH_PROVIDER_INVALID",
			"provider.adopt must be a function when present",
		);
	}
	return value as never;
}

function createScratchWorld(seeded: readonly ScratchResource[]): ScratchWorld {
	const resources = new Map<string, ScratchResource>();
	const counters = new Map<string, number>();
	for (const resource of seeded) {
		resources.set(resource.id, resource);
	}

	function list(): readonly ScratchResource[] {
		return Object.freeze(
			[...resources.values()].sort((left, right) =>
				compareText(left.id, right.id),
			),
		);
	}

	return {
		list,
		get(instanceId: string): ScratchResource | undefined {
			return resources.get(instanceId);
		},
		find(logicalId: string): ScratchResource | undefined {
			for (const resource of list()) {
				if (resource.logicalId === logicalId) {
					return resource;
				}
			}
			return undefined;
		},
		put(resource: ScratchResource): ScratchResource {
			const stored = Object.freeze({ ...resource });
			resources.set(stored.id, stored);
			return stored;
		},
		remove(instanceId: string): boolean {
			return resources.delete(instanceId);
		},
		nextInstanceId(logicalId: string): string {
			const next = (counters.get(logicalId) ?? 0) + 1;
			counters.set(logicalId, next);
			return `scratch:${logicalId}#${next}`;
		},
	};
}

interface JournalEntry {
	readonly instanceId: string;
	readonly type: string;
	readonly properties: JsonObject;
	readonly stables: JsonObject;
	readonly live: boolean;
}

export function createScratchStack(
	options: CreateScratchStackOptions = {},
): ScratchStack {
	const provider =
		options.provider === undefined
			? createReferenceScratchProvider()
			: parseScratchProvider(options.provider);
	const world = createScratchWorld(parseScratchSeed(options.seed));
	const journal = new Map<string, JournalEntry>();

	function contextFor(
		desired: ScratchDesired,
		current: ScratchResource | undefined,
	): ScratchProviderContext {
		return {
			world,
			type: desired.type,
			logicalId: desired.logicalId,
			properties: desired.properties,
			stables: desired.stables,
			...(current !== undefined ? { current } : undefined),
		};
	}

	async function reconcile(
		desired: ScratchDesired,
	): Promise<ScratchProviderResult> {
		const entry = journal.get(desired.logicalId);
		const believed =
			entry?.live === true ? world.get(entry.instanceId) : undefined;

		if (entry !== undefined && believed !== undefined) {
			if (canonicalJson(entry.stables) !== canonicalJson(desired.stables)) {
				await provider.delete({
					...contextFor(desired, believed),
					current: believed,
				});
				return await provider.create(contextFor(desired, undefined));
			}
			if (
				canonicalJson(entry.properties) !== canonicalJson(desired.properties)
			) {
				return await provider.update({
					...contextFor(desired, believed),
					current: believed,
				});
			}
			return await provider.create(contextFor(desired, undefined));
		}

		const foreign = world.find(desired.logicalId);
		if (foreign !== undefined && !foreign.owned) {
			if (provider.adopt === undefined) {
				throw new ProviderLifecycleError(
					"SCRATCH_ADOPT_UNSUPPORTED",
					`provider declares no adopt(), so foreign resource ${foreign.id} cannot become owned`,
				);
			}
			return await provider.adopt({
				...contextFor(desired, foreign),
				current: foreign,
			});
		}
		return await provider.create(contextFor(desired, undefined));
	}

	return {
		async deploy(desiredInput: ScratchDesired) {
			const desired = parseScratchDesired(desiredInput);
			const result = requireRecord(
				await reconcile(desired),
				"SCRATCH_PROVIDER_INVALID",
				"provider result",
			);
			const instanceId = requireText(
				result.instanceId,
				"SCRATCH_PROVIDER_INVALID",
				"provider result.instanceId",
			);
			const outputs = optionalRecord(
				result.outputs,
				"SCRATCH_PROVIDER_INVALID",
				"provider result.outputs",
			);
			journal.set(desired.logicalId, {
				instanceId,
				type: desired.type,
				properties: desired.properties,
				stables: desired.stables,
				live: true,
			});
			return Object.freeze({ outputs, instanceId });
		},
		async destroy(): Promise<void> {
			for (const [logicalId, entry] of [...journal.entries()].reverse()) {
				const current: ScratchResource = world.get(entry.instanceId) ?? {
					id: entry.instanceId,
					type: entry.type,
					logicalId,
					owned: true,
					outputs: Object.freeze({}),
					stables: entry.stables,
				};
				await provider.delete({
					world,
					type: entry.type,
					logicalId,
					properties: entry.properties,
					stables: entry.stables,
					current,
				});
				journal.set(logicalId, { ...entry, live: false });
			}
		},
		state: {
			list(): readonly { readonly id: string; readonly type: string }[] {
				return Object.freeze(
					world
						.list()
						.map((resource) =>
							Object.freeze({ id: resource.id, type: resource.type }),
						),
				);
			},
			resources(): readonly ScratchResource[] {
				return world.list();
			},
		},
	};
}

export function createReferenceScratchProvider(): ScratchProvider {
	function outputsFor(context: ScratchProviderContext): JsonObject {
		return Object.freeze({
			...context.properties,
			endpoint: `scratch://${context.logicalId}`,
		});
	}

	return {
		create(context: ScratchProviderContext): ScratchProviderResult {
			const existing = context.world.find(context.logicalId);
			if (existing?.owned === true) {
				const refreshed = context.world.put({
					...existing,
					outputs: outputsFor(context),
					stables: context.stables,
				});
				return { instanceId: refreshed.id, outputs: refreshed.outputs };
			}
			const created = context.world.put({
				id: context.world.nextInstanceId(context.logicalId),
				type: context.type,
				logicalId: context.logicalId,
				owned: true,
				outputs: outputsFor(context),
				stables: context.stables,
			});
			return { instanceId: created.id, outputs: created.outputs };
		},
		update(context: ScratchOwnedContext): ScratchProviderResult {
			const updated = context.world.put({
				...context.current,
				outputs: outputsFor(context),
				stables: context.stables,
			});
			return { instanceId: updated.id, outputs: updated.outputs };
		},
		delete(context: ScratchOwnedContext): void {
			context.world.remove(context.current.id);
		},
		adopt(context: ScratchOwnedContext): ScratchProviderResult {
			const adopted = context.world.put({
				...context.current,
				owned: true,
				outputs: outputsFor(context),
				stables: context.stables,
			});
			return { instanceId: adopted.id, outputs: adopted.outputs };
		},
	};
}

function assertLifecycle(
	condition: boolean,
	message: string,
): asserts condition {
	if (!condition) {
		throw new ProviderLifecycleError("LIFECYCLE_ASSERTION_FAILED", message);
	}
}

function withProperties(properties: JsonObject): ScratchDesired {
	return Object.freeze({
		...BASE_DESIRED,
		properties: Object.freeze(properties),
	});
}

function withStables(stables: JsonObject): ScratchDesired {
	return Object.freeze({ ...BASE_DESIRED, stables: Object.freeze(stables) });
}

export const PROVIDER_LIFECYCLE_SUITE: readonly ProviderLifecycleCase[] =
	Object.freeze([
		Object.freeze({
			name: PROVIDER_LIFECYCLE_CASE_NAMES.create,
			run: async (stack: ScratchStack): Promise<void> => {
				const created = await stack.deploy(BASE_DESIRED);
				assertLifecycle(
					created.instanceId.length > 0,
					"create returned no instance id",
				);
				assertLifecycle(
					Object.keys(created.outputs).length > 0,
					"create returned no outputs",
				);
				const instances = stack.state.list();
				assertLifecycle(
					instances.length === 1,
					`create left ${instances.length} instances in the scratch world, expected 1`,
				);
				assertLifecycle(
					instances[0]?.id === created.instanceId,
					"the instance in state is not the one create reported",
				);
			},
		}),
		Object.freeze({
			name: PROVIDER_LIFECYCLE_CASE_NAMES.updateInPlace,
			run: async (stack: ScratchStack): Promise<void> => {
				const before = await stack.deploy(BASE_DESIRED);
				const after = await stack.deploy(
					withProperties({ label: "beta", size: "large" }),
				);
				assertLifecycle(
					after.instanceId === before.instanceId,
					`a property change replaced the instance (${before.instanceId} -> ${after.instanceId}); only a stable field may do that`,
				);
				assertLifecycle(
					canonicalJson(after.outputs) !== canonicalJson(before.outputs),
					"the outputs did not change after a property change, so the update never reached the resource",
				);
				assertLifecycle(
					stack.state.list().length === 1,
					"an in-place update left more than one instance",
				);
			},
		}),
		Object.freeze({
			name: PROVIDER_LIFECYCLE_CASE_NAMES.replace,
			run: async (stack: ScratchStack): Promise<void> => {
				const before = await stack.deploy(BASE_DESIRED);
				const after = await stack.deploy(
					withStables({ region: "scratch-west" }),
				);
				assertLifecycle(
					after.instanceId !== before.instanceId,
					`a declared-stable field changed but the instance id stayed ${before.instanceId}; that is an in-place mutation of an immutable field`,
				);
				const instances = stack.state.list();
				assertLifecycle(
					instances.length === 1,
					`replace left ${instances.length} instances, expected the old one to be gone`,
				);
				assertLifecycle(
					instances[0]?.id === after.instanceId,
					"the surviving instance is not the replacement",
				);
			},
		}),
		Object.freeze({
			name: PROVIDER_LIFECYCLE_CASE_NAMES.deleteIdempotent,
			run: async (stack: ScratchStack): Promise<void> => {
				await stack.deploy(BASE_DESIRED);
				await stack.destroy();
				assertLifecycle(
					stack.state.list().length === 0,
					"destroy left the resource behind",
				);
				await stack.destroy();
				assertLifecycle(
					stack.state.list().length === 0,
					"the second destroy resurrected something",
				);
			},
		}),
		Object.freeze({
			name: PROVIDER_LIFECYCLE_CASE_NAMES.adopt,
			seed: ADOPT_SEED,
			run: async (stack: ScratchStack): Promise<void> => {
				const adopted = await stack.deploy(BASE_DESIRED);
				assertLifecycle(
					adopted.instanceId === FOREIGN_INSTANCE_ID,
					`adoption minted ${adopted.instanceId} instead of taking over the pre-existing ${FOREIGN_INSTANCE_ID}`,
				);
				const instances = stack.state.resources();
				assertLifecycle(
					instances.length === 1,
					`adoption left ${instances.length} instances, expected the foreign one alone`,
				);
				assertLifecycle(
					instances[0]?.owned === true,
					"the adopted resource is still marked foreign",
				);
			},
		}),
		Object.freeze({
			name: PROVIDER_LIFECYCLE_CASE_NAMES.crashResume,
			run: async (stack: ScratchStack): Promise<void> => {
				const first = await stack.deploy(BASE_DESIRED);
				const second = await stack.deploy(BASE_DESIRED);
				assertLifecycle(
					second.instanceId === first.instanceId,
					`the resumed apply minted ${second.instanceId} on top of ${first.instanceId}; a crashed apply would double-provision`,
				);
				assertLifecycle(
					canonicalJson(second.outputs) === canonicalJson(first.outputs),
					"the resumed apply reported different outputs for unchanged desired state",
				);
				const instances = stack.state.list();
				assertLifecycle(
					instances.length === 1,
					`reconciling twice left ${instances.length} instances, expected exactly 1`,
				);
			},
		}),
	]);

export const PROVIDER_LIFECYCLE_SUITE_DESCRIPTOR: ConformanceSuiteDescriptor =
	Object.freeze({
		suiteId: PROVIDER_LIFECYCLE_SUITE_ID,
		dimension: "provider-lifecycle",
		checks: Object.freeze(
			Object.values(PROVIDER_LIFECYCLE_CASE_NAMES).sort(compareText),
		),
		caseIds: Object.freeze(
			PROVIDER_LIFECYCLE_SUITE.map((suiteCase) => suiteCase.name),
		),
	});

export async function runProviderLifecycleConformance<T>(
	provider: T,
	options: { readonly cases?: readonly ProviderLifecycleCase[] } = {},
): Promise<ProviderLifecycleResult> {
	const parsed = parseScratchProvider(provider);
	const cases = options.cases ?? PROVIDER_LIFECYCLE_SUITE;
	const failed: ProviderLifecycleFailure[] = [];
	let passed = 0;

	for (const suiteCase of cases) {
		const stack = createScratchStack({
			provider: parsed,
			...(suiteCase.seed !== undefined ? { seed: suiteCase.seed } : undefined),
		});
		try {
			await suiteCase.run(stack);
			passed += 1;
		} catch (error) {
			failed.push(
				Object.freeze({ name: suiteCase.name, error: messageOf(error) }),
			);
		}
	}

	return Object.freeze({ passed, failed: Object.freeze(failed) });
}
