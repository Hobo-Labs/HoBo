import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
// One adapter, two interchangeable binaries (they share the plan/apply/state
// protocol); OpenTofu is the default per control-plane.md §IaC backends.
// public-contract: the pinned OpenTofu toolchain the default engine declares.
export const PINNED_TOFU_VERSION = "1.8.3";
// public-contract: the pinned Terraform toolchain the terraform lane declares.
export const PINNED_TERRAFORM_VERSION = "1.9.8";
// The SAME wire schema the Pulumi adapter consumes; only `provider` differs.
// public-contract: the IacProgram schema version validateIacProgram accepts.
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
// public-contract: the adapter id stamped on every report this package emits.
export const ADAPTER_ID = "@hobo/iac-terraform";
// public-contract: the provider tokens this adapter accepts on a program.
export const HCL_PROVIDERS = Object.freeze(["terraform", "opentofu"] as const);

const OUTPUT_REF =
	/^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;

export class TerraformProgramError extends Error {
	code: string;

	constructor(code, message) {
		super(message);
		this.name = "TerraformProgramError";
		this.code = code;
	}
}

export class TerraformApplyError extends Error {
	code: string;

	constructor(code, message) {
		super(message);
		this.name = "TerraformApplyError";
		this.code = code;
	}
}

export class TerraformStateError extends Error {
	code: string;

	constructor(code, message) {
		super(message);
		this.name = "TerraformStateError";
		this.code = code;
	}
}

/**
 * Stored stack/workspace state as this module reads it.
 *
 * `resources` is read back as `JsonValue` and narrowed at use, rather than
 * declared as `Record<string, ResourceOutcome>` beside a `JsonValue` index
 * signature. TypeScript requires every named property to be assignable to that
 * signature, and a record of a *specific* interface is not -- the two
 * declarations contradict each other, and the index signature is the one that
 * has to hold, because this shape is parsed from a state file nobody here
 * wrote.
 */
interface StoredState {
	readonly [key: string]: JsonValue;
}

/** A resource in a realization outputs payload. */
interface ResourceOutcome {
	readonly id?: string;
	readonly status?: string;
	readonly outputs?: JsonObject;
}

/** Overrides accepted by the trivial fixture program. */
interface ProgramOverrides {
	readonly resources?: JsonValue;
	readonly stackOutputs?: JsonValue;
	readonly [key: string]: JsonValue;
}

/** Options for the Terraform/OpenTofu adapter. */
interface AdapterOptions {
	readonly stateBackend?: ReturnType<typeof createInMemoryStateBackend>;
	readonly engine?: EngineLike;
	readonly binary?: string;
	readonly toolchainVersion?: string;
}

/** What an adapter actually calls on its engine — any lane may implement it. */
interface EngineLike {
	readonly toolchainVersion?: string;
	readonly binary?: string;
	snapshot?(): JsonValue;
	preview(
		program: JsonValue,
	): Promise<{ changes: readonly unknown[] }> | { changes: readonly unknown[] };
	apply(
		program: JsonValue,
		expected: readonly unknown[],
	):
		| Promise<{ appliedChanges?: readonly unknown[]; outputs?: unknown }>
		| { appliedChanges?: readonly unknown[]; outputs?: unknown };
	refresh(program: JsonValue): JsonValue;
	destroy(program: JsonValue): JsonValue;
}

/** Options for the offline state backend. */
interface StateBackendOptions {
	readonly failOnWriteFor?: string;
}

/** Options for the offline HCL engine. */
interface EngineOptions {
	readonly stateBackend?: ReturnType<typeof createInMemoryStateBackend>;
	readonly lockHolder?: string;
	readonly failAfterResource?: string;
}

export function createTrivialIacProgram(overrides: ProgramOverrides = {}) {
	const base = {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: "iac-program",
		provider: "opentofu",
		deploymentId: "trivial-demo",
		stack: "tenant/trivial-demo",
		resources: [
			{
				name: "hello",
				type: "hobo:trivial/greeting",
				provider: "local",
				inputs: { message: "hello-bindle" },
				outputs: ["greeting", "resourceId"],
			},
		],
		stackOutputs: {
			greeting: "${resources.hello.outputs.greeting}",
		},
	};

	return deepFreeze({
		...base,
		...structuredClone(overrides),
		resources: structuredClone(overrides.resources ?? base.resources),
		stackOutputs: structuredClone(overrides.stackOutputs ?? base.stackOutputs),
	});
}

// Per-resource workspace key: `deploymentId/resourceName` — one HCL workspace
// (own local state) per resource, the same blast-radius isolation the Pulumi
// adapter's per-resource stacks give (control-plane.md §IaC state model).
export function createWorkspaceKey(program, resourceName) {
	const deploymentId = program.deploymentId ?? program.stack ?? "default";
	return `${deploymentId}/${resourceName}`;
}

export function createTerraformAdapter(options: AdapterOptions = {}) {
	const stateBackend = options.stateBackend ?? createInMemoryStateBackend();
	// The default engine is the deterministic in-memory stand-in so the package
	// stays offline; swap `options.engine` for createTerraformCliEngine (the
	// REAL tofu/terraform binary) — same preview/apply/refresh/destroy shape,
	// proven by runIacBackendConformance.
	const engine = options.engine ?? createInMemoryHclEngine({ stateBackend });
	const binary = options.binary ?? engine.binary ?? "tofu";
	// An engine's reported version is evidence about the binary that engine
	// runs, so it only applies when that is the binary we resolved. Without the
	// check, `createTerraformAdapter({ binary: "terraform" })` over the default
	// in-memory engine reported terraform 1.8.3 -- the engine hardcodes the tofu
	// version, and it shadowed the pinned default below. Terraform has no 1.8.3;
	// that is OpenTofu's line. These values go onto provisioning receipts, whose
	// whole job is to say which toolchain did the work.
	const engineVersion =
		engine.binary === undefined || engine.binary === binary
			? engine.toolchainVersion
			: undefined;
	const toolchainVersion =
		options.toolchainVersion ??
		engineVersion ??
		(binary === "terraform" ? PINNED_TERRAFORM_VERSION : PINNED_TOFU_VERSION);

	return deepFreeze({
		id: ADAPTER_ID,
		binary,
		toolchainVersion,
		stateBackend: stateBackend.describe(),
		// Estate discovery seam (drift/import parity with @hobo/iac-pulumi).
		snapshotState() {
			return engine.snapshot instanceof Function
				? engine.snapshot()
				: stateBackend.snapshot();
		},
		async preview(program) {
			const parsed = validateIacProgram(program);
			return engine.preview(parsed);
		},
		async apply(program) {
			const parsed = validateIacProgram(program);
			const expected = await engine.preview(parsed);
			const result = await engine.apply(parsed, expected.changes);

			if (!sameChanges(expected.changes, result.appliedChanges)) {
				const unexpected = result.appliedChanges.find(
					(change) =>
						!expected.changes.some((candidate) =>
							sameChange(candidate, change),
						),
				);
				throw new TerraformApplyError(
					"plan-apply-divergence",
					`plan/apply divergence: apply attempted unexpected resource ${unexpected?.resource ?? "unknown"}`,
				);
			}

			return {
				...result.outputs,
				bindings: outputsToBindings(result.outputs),
			};
		},
		async refresh(program) {
			const parsed = validateIacProgram(program);
			return engine.refresh(parsed);
		},
		async destroy(program) {
			const parsed = validateIacProgram(program);
			return engine.destroy(parsed);
		},
	});
}

export function createInMemoryStateBackend(options: StateBackendOptions = {}) {
	const stores = new Map();
	const locks = new Map();

	return {
		kind: "memory",
		describe() {
			return deepFreeze({
				kind: "memory",
				lockHolder: locks.get("global") ?? null,
			});
		},
		read(workspaceKey) {
			return structuredClone(stores.get(workspaceKey) ?? { resources: {} });
		},
		write(workspaceKey, state) {
			if (options.failOnWriteFor === workspaceKey) {
				throw new TerraformStateError(
					"state-write-failed",
					`state write failed for ${workspaceKey}`,
				);
			}
			stores.set(workspaceKey, structuredClone(state));
		},
		holdLock(workspaceKey, holder) {
			const existing = locks.get(workspaceKey);
			if (existing && existing !== holder) {
				throw new TerraformStateError(
					"state-lock-held",
					`HCL state lock for ${workspaceKey} is held by ${existing}`,
				);
			}
			locks.set(workspaceKey, holder);
		},
		releaseLock(workspaceKey, holder) {
			if (locks.get(workspaceKey) === holder) {
				locks.delete(workspaceKey);
			}
		},
		snapshot() {
			return deepFreeze(Object.fromEntries(stores.entries()));
		},
	};
}

// Deterministic in-memory HCL engine: the offline stand-in for the real
// tofu/terraform binary (createTerraformCliEngine). The return shapes below
// are the contract the CLI engine preserves (runIacBackendConformance proves
// both). Semantics mirror the Pulumi in-memory engine so every IaC adapter in
// HoBo folds the same way.
export function createInMemoryHclEngine(options: EngineOptions = {}) {
	const stateBackend = options.stateBackend ?? createInMemoryStateBackend();
	let driftWorkspaces = new Map();

	return {
		binary: "tofu",
		toolchainVersion: PINNED_TOFU_VERSION,
		stateBackend,
		snapshot() {
			return stateBackend.snapshot();
		},
		async preview(program) {
			const changes = [];

			for (const resource of program.resources) {
				const workspaceKey = createWorkspaceKey(program, resource.name);
				const state = stateBackend.read(workspaceKey);
				const diff = diffResource(resource, state);

				if (diff) {
					changes.push({
						op: diff.op,
						resource: resource.name,
						workspaceKey,
						reason: diff.reason,
					});
				}
			}

			for (const [workspaceKey, state] of Object.entries<StoredState>(
				stateBackend.snapshot(),
			)) {
				const resourceName = workspaceKey.split("/").at(-1);
				const stillDesired = program.resources.some(
					(resource) => resource.name === resourceName,
				);

				if (!stillDesired && Object.keys(state.resources ?? {}).length > 0) {
					changes.push({
						op: "delete",
						resource: resourceName,
						workspaceKey,
						reason: "extra-per-resource-workspace",
					});
				}
			}

			return deepFreeze({
				kind: "diff",
				provider: "terraform",
				model: "per-resource-workspace",
				changes,
				dirty: changes.length > 0,
			});
		},
		async apply(program, expectedChanges) {
			for (const resource of program.resources) {
				const workspaceKey = createWorkspaceKey(program, resource.name);
				stateBackend.holdLock(
					workspaceKey,
					options.lockHolder ?? "resource-actor:self",
				);
				const record = provisionedRecord(resource);

				try {
					stateBackend.write(workspaceKey, {
						resources: { [resource.name]: record },
					});
				} finally {
					stateBackend.releaseLock(
						workspaceKey,
						options.lockHolder ?? "resource-actor:self",
					);
				}

				if (options.failAfterResource === resource.name) {
					for (const candidate of program.resources) {
						driftWorkspaces.set(createWorkspaceKey(program, candidate.name), {
							reason:
								candidate.name === resource.name
									? "partial-apply-provisioned"
									: "not-applied-after-partial-failure",
						});
					}
					const next =
						program.resources[program.resources.indexOf(resource) + 1];
					throw new TerraformApplyError(
						"partial-apply",
						`partial apply failed after ${resource.name} before ${next?.name ?? "completion"}`,
					);
				}
			}

			driftWorkspaces = new Map();

			return {
				appliedChanges: structuredClone(expectedChanges),
				outputs: outputsFor(program, stateBackend),
			};
		},
		async refresh(program) {
			if (driftWorkspaces.size > 0) {
				return deepFreeze({
					kind: "drift-report",
					provider: "terraform",
					model: "per-resource-workspace",
					drifted: true,
					resources: [...driftWorkspaces.entries()].map(
						([workspaceKey, detail]) => ({
							name: workspaceKey.split("/").at(-1),
							workspaceKey,
							reason: detail.reason,
						}),
					),
				});
			}

			// Refresh judges ONLY the program's own workspaces — drift is per
			// workspace, never a sibling scan (parity with the Pulumi engine).
			const drifted = [];
			for (const resource of program.resources) {
				const workspaceKey = createWorkspaceKey(program, resource.name);
				const state = stateBackend.read(workspaceKey);
				const diff = diffResource(resource, state);
				if (diff) {
					drifted.push({
						name: resource.name,
						workspaceKey,
						reason: diff.reason,
					});
				}
			}

			return deepFreeze({
				kind: "drift-report",
				provider: "terraform",
				model: "per-resource-workspace",
				drifted: drifted.length > 0,
				resources: drifted,
			});
		},
		async destroy(program) {
			const destroyed = {};
			const reverseOrder = [...program.resources].reverse();

			for (const resource of reverseOrder) {
				const workspaceKey = createWorkspaceKey(program, resource.name);
				const state = stateBackend.read(workspaceKey);
				const existing = state.resources?.[resource.name];

				destroyed[resource.name] = {
					id: existing?.id ?? resourceId(resource.name),
					workspaceKey,
					status: "destroyed",
					outputs: {},
				};

				stateBackend.write(workspaceKey, { resources: {} });
			}

			driftWorkspaces = new Map();

			return deepFreeze({
				kind: "outputs",
				provider: "terraform",
				model: "per-resource-workspace",
				resources: destroyed,
				stackOutputs: {},
				bindings: {},
			});
		},
	};
}

export function outputsToBindings(outputs) {
	const bindings = {};

	for (const [resourceName, resource] of Object.entries<ResourceOutcome>(
		outputs.resources ?? {},
	)) {
		for (const [outputName, value] of Object.entries(resource.outputs ?? {})) {
			bindings[`${resourceName}.${outputName}`] = value;
			bindings[`\${resources.${resourceName}.outputs.${outputName}}`] = value;
		}
	}

	for (const [key, value] of Object.entries(outputs.stackOutputs ?? {})) {
		bindings[`stack.${key}`] = value;
	}

	return deepFreeze(bindings);
}

// The same @hobo/conformance/iac-backend smoke every IaC adapter passes —
// identical assertion names to the Pulumi and Crossplane lanes, so backends
// stay substitutable behind one shape.
export async function runIacBackendConformance({ adapter, program }) {
	const preview = await adapter.preview(program);
	assertConformance(preview.kind === "diff" && preview.dirty, "preview-diff");

	const outputs = await adapter.apply(program);
	assertConformance(
		outputs.kind === "outputs" && Object.keys(outputs.resources).length > 0,
		"apply-outputs",
	);
	assertConformance(
		outputs.bindings && Object.keys(outputs.bindings).length > 0,
		"binding-outputs",
	);

	const refresh = await adapter.refresh(program);
	assertConformance(
		refresh.kind === "drift-report" && refresh.drifted === false,
		"refresh-clean",
	);

	const destroy = await adapter.destroy(program);
	assertConformance(
		destroy.kind === "outputs" &&
			Object.values<ResourceOutcome>(destroy.resources).every(
				(resource) => resource.status === "destroyed",
			),
		"destroy-clean",
	);

	return deepFreeze({
		suite: "@hobo/conformance/iac-backend",
		provider: "terraform",
		passed: true,
		assertions: [
			"preview-diff",
			"apply-outputs",
			"binding-outputs",
			"refresh-clean",
			"destroy-clean",
		],
	});
}

export function validateIacProgram(program) {
	// Parse, don't validate: returns a frozen, derived parsed domain program so
	// callers work with a trusted ParsedIacProgram instead of re-checking DTO fields.
	if (!program || !isJsonObject(program)) {
		throw new TerraformProgramError(
			"invalid-program",
			"IacProgram must be an object",
		);
	}
	if (program.apiVersion !== IAC_PROGRAM_API_VERSION) {
		throw new TerraformProgramError(
			"invalid-api-version",
			`IacProgram apiVersion must be ${IAC_PROGRAM_API_VERSION}`,
		);
	}
	if (program.kind !== "iac-program") {
		throw new TerraformProgramError(
			"invalid-kind",
			"IacProgram kind must be iac-program",
		);
	}
	if (!HCL_PROVIDERS.includes(program.provider)) {
		throw new TerraformProgramError(
			"invalid-provider",
			`IacProgram provider must be one of ${HCL_PROVIDERS.join(", ")}`,
		);
	}
	if (!Array.isArray(program.resources) || program.resources.length === 0) {
		throw new TerraformProgramError(
			"empty-program",
			"IacProgram must include at least one resource",
		);
	}

	const resources = new Map();

	for (const resource of program.resources) {
		if (!resource?.name) {
			throw new TerraformProgramError(
				"invalid-resource",
				"IacProgram resource missing name",
			);
		}
		if (resources.has(resource.name)) {
			throw new TerraformProgramError(
				"duplicate-resource",
				`IacProgram includes duplicate resource ${resource.name}`,
			);
		}
		resources.set(resource.name, resource);
	}

	for (const value of collectValues(program.resources)) {
		validateOutputReference(value, resources);
	}
	for (const value of Object.values(program.stackOutputs ?? {})) {
		validateOutputReference(value, resources);
	}

	return deepFreeze(structuredClone(program));
}

function assertConformance(condition, assertion) {
	if (!condition) {
		throw new TerraformApplyError(
			"conformance-failed",
			`IaC backend conformance assertion failed: ${assertion}`,
		);
	}
}

function validateOutputReference(value, resources) {
	if (!isJsonString(value) || !value.startsWith("${resources.")) {
		return;
	}

	const match = OUTPUT_REF.exec(value);
	if (!match) {
		throw new TerraformProgramError(
			"invalid-output-reference",
			`invalid output reference ${value}`,
		);
	}

	const [, resourceName, outputName] = match;
	const resource = resources.get(resourceName);

	if (!resource || !(resource.outputs ?? []).includes(outputName)) {
		throw new TerraformProgramError(
			"unresolved-output-reference",
			`unresolved output reference resources.${resourceName}.outputs.${outputName}`,
		);
	}
}

function diffResource(resource, state) {
	const existing = state.resources?.[resource.name];

	if (!existing) {
		return { op: "create", reason: "missing-from-per-resource-workspace" };
	}

	if (existing.specHash !== stableJson(resource)) {
		return { op: "update", reason: "spec-drift" };
	}

	return null;
}

function provisionedRecord(resource) {
	const outputs = {
		endpoint: `terraform://${resource.name}`,
		resourceId: resourceId(resource.name),
		greeting: resource.inputs?.message ?? `hello-${resource.name}`,
	};

	return {
		id: resourceId(resource.name),
		status: "provisioned",
		outputs,
		specHash: stableJson(resource),
	};
}

function outputsFor(program, stateBackend) {
	const resources = {};

	for (const resource of program.resources) {
		const workspaceKey = createWorkspaceKey(program, resource.name);
		const state = stateBackend.read(workspaceKey);
		const existing =
			state.resources?.[resource.name] ?? provisionedRecord(resource);

		resources[resource.name] = {
			id: existing.id,
			workspaceKey,
			status: existing.status,
			outputs: structuredClone(existing.outputs),
		};
	}

	const stackOutputs = resolveStackOutputs(
		program.stackOutputs ?? {},
		resources,
	);

	return deepFreeze({
		kind: "outputs",
		provider: "terraform",
		model: "per-resource-workspace",
		resources,
		stackOutputs,
		bindings: outputsToBindings({ resources, stackOutputs }),
	});
}

function resolveStackOutputs(stackOutputs, resources) {
	return Object.fromEntries(
		Object.entries(stackOutputs).map(([key, value]) => [
			key,
			resolveValue(value, resources),
		]),
	);
}

function resolveValue(value, resources) {
	const match = isJsonString(value) ? OUTPUT_REF.exec(value) : undefined;

	if (!match) {
		return structuredClone(value);
	}

	const [, resourceName, outputName] = match;
	return resources[resourceName].outputs[outputName];
}

function resourceId(name) {
	return `terraform:workspace:${name}`;
}

function collectValues(value) {
	// Arrays first: `isJsonObject` excludes them by design, so without this
	// branch an array fell through and was returned as a single non-string
	// value. The caller passes `program.resources`, which IS an array, so no
	// output reference inside any resource was ever validated -- only
	// stackOutputs, which is iterated directly.
	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectValues(entry));
	}
	if (!value || !isJsonObject(value)) {
		return [value];
	}

	return Object.values(value).flatMap((child) => collectValues(child));
}

function sameChanges(left, right) {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((change) =>
		right.some((candidate) => sameChange(candidate, change)),
	);
}

function sameChange(left, right) {
	return left.op === right.op && left.resource === right.resource;
}

function stableJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && isJsonObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}

	return JSON.stringify(value);
}

function deepFreeze(value) {
	if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
		return value;
	}

	Object.freeze(value);

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return value;
}
