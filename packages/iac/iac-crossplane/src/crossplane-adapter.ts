import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
// The SAME wire schema every HoBo IaC adapter consumes; only `provider` differs.
// public-contract: the IacProgram schema version validateIacProgram accepts.
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
// public-contract: the claim apiVersion this adapter renders.
export const CROSSPLANE_CLAIM_API_VERSION = "hobo.iac-crossplane/v1";
// public-contract: the adapter id stamped on every report this package emits.
export const ADAPTER_ID = "@hobo/iac-crossplane";

const OUTPUT_REF =
	/^\$\{resources\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;
const REQUIRED_CRDS = ["CompositeResourceClaim", "Composition"];

export class CrossplaneProgramError extends Error {
	code: string;

	constructor(code, message) {
		super(message);
		this.name = "CrossplaneProgramError";
		this.code = code;
	}
}

export class CrossplaneApplyError extends Error {
	code: string;

	constructor(code, message) {
		super(message);
		this.name = "CrossplaneApplyError";
		this.code = code;
	}
}

// The cluster seam every lane implements: the in-memory fixture (offline
// default, promoted from the HOBO-188 draft proof) and the real kubectl-driven
// cluster (kubectl-cluster.ts) speak the same surface, so the adapter cannot
// tell them apart — runIacBackendConformance is the proof.
/** A composition as the adapter reads it: matched on its labels, named in a claim. */
export interface CrossplaneComposition {
	readonly name: string;
	readonly labels?: Record<string, string>;
	readonly [key: string]: JsonValue;
}

/** A claim as the adapter reads it — see `claimFor` for the writer. */
export interface CrossplaneClaim {
	readonly id: string;
	readonly name: string;
	readonly spec: JsonObject;
	readonly specHash: string;
	readonly status: {
		readonly phase: string;
		readonly outputs: JsonObject;
	};
	/** Snapshot of outputs recorded at apply time; drives status-drift detection. */
	readonly appliedOutputs?: JsonObject;
}

/** A realized resource inside an `outputs` payload. Distinct from a claim. */
export interface CrossplaneResourceOutcome {
	readonly id?: string;
	readonly status?: string;
	readonly outputs?: JsonObject;
}

/** Fields the in-memory cluster lets a test mutate on a stored claim. */
export interface CrossplaneClaimMutation {
	readonly specPatch?: JsonObject;
	readonly statusPatch?: JsonObject;
	readonly phase?: string;
}

export interface CrossplaneClusterLike {
	hasCrd(name: string): boolean | Promise<boolean>;
	compositions():
		| readonly CrossplaneComposition[]
		| Promise<readonly CrossplaneComposition[]>;
	// A command, not a query: every caller awaits it and discards the result.
	applyClaim(claim: CrossplaneClaim): void | Promise<void>;
	waitForReady(name: string, pollLimit: number): boolean | Promise<boolean>;
	/** Absent claims come back nullish; callers already branch on that. */
	getClaim(
		name: string,
	):
		| CrossplaneClaim
		| undefined
		| null
		| Promise<CrossplaneClaim | undefined | null>;
	claimNames(): string[] | Promise<string[]>;
	deleteClaim(name: string): void | Promise<void>;
}

export function createFixtureIacProgram(overrides: JsonObject = {}) {
	const base = {
		apiVersion: IAC_PROGRAM_API_VERSION,
		kind: "iac-program",
		provider: "crossplane",
		deploymentId: "hobo-crossplane-fixture",
		stack: "hobo-crossplane-fixture",
		resources: [
			{
				name: "database",
				type: "hobo:database/postgres",
				provider: "kubernetes",
				inputs: {
					compositionSelector: {
						matchLabels: { port: "database", class: "postgres" },
					},
					parameters: { storageGiB: 20 },
				},
				outputs: ["endpoint", "resourceId"],
			},
			{
				name: "cache",
				type: "hobo:cache/redis",
				provider: "kubernetes",
				inputs: {
					compositionSelector: {
						matchLabels: { port: "cache", class: "redis" },
					},
					parameters: { memoryMiB: 256 },
				},
				outputs: ["endpoint", "resourceId"],
			},
		],
		stackOutputs: {
			cacheEndpoint: "${resources.cache.outputs.endpoint}",
			databaseEndpoint: "${resources.database.outputs.endpoint}",
		},
	};

	return deepFreeze({
		...base,
		...structuredClone(overrides),
		resources: structuredClone(overrides.resources ?? base.resources),
		stackOutputs: structuredClone(overrides.stackOutputs ?? base.stackOutputs),
	});
}

export interface CrossplaneAdapterOptions {
	readonly cluster?: CrossplaneClusterLike;
	readonly readyPollLimit?: number;
}

export function createCrossplaneIacAdapter(
	options: CrossplaneAdapterOptions = {},
) {
	const cluster: CrossplaneClusterLike =
		options.cluster ?? createInMemoryCrossplaneCluster();
	const readyPollLimit = options.readyPollLimit ?? 3;

	return deepFreeze({
		id: ADAPTER_ID,
		model: "composite-resource-claim",
		async preview(program) {
			const normalized = validateIacProgram(program);
			return diffFor(normalized, cluster);
		},
		async apply(program) {
			const normalized = validateIacProgram(program);
			await ensureRequiredCrds(cluster);

			// Selector resolution fails closed for EVERY resource before any claim
			// is applied — a half-applied program is worse than a rejected one.
			for (const resource of normalized.resources) {
				await selectComposition(cluster, resource);
			}

			const applied = {};
			for (const resource of normalized.resources) {
				const claim = claimFor(
					resource,
					await selectComposition(cluster, resource),
				);
				await cluster.applyClaim(claim);
				const ready = await cluster.waitForReady(resource.name, readyPollLimit);
				if (!ready) {
					throw new CrossplaneApplyError(
						"ready-timeout",
						`${resource.name} did not reach Ready after ${readyPollLimit} polls`,
					);
				}
				applied[resource.name] = outputsForClaim(
					await cluster.getClaim(resource.name),
					resource,
				);
			}

			const stackOutputs = resolveStackOutputs(
				normalized.stackOutputs ?? {},
				applied,
			);
			return deepFreeze({
				kind: "outputs",
				provider: "crossplane",
				model: "composite-resource-claim",
				resources: applied,
				stackOutputs,
				bindings: outputsToBindings({ resources: applied, stackOutputs }),
			});
		},
		async refresh(program) {
			const normalized = validateIacProgram(program);
			const resources = [];
			const desiredNames = new Set(
				normalized.resources.map((resource) => resource.name),
			);

			for (const resource of normalized.resources) {
				const claim = await cluster.getClaim(resource.name);
				if (!claim) {
					resources.push({ name: resource.name, reason: "claim-missing" });
					continue;
				}
				const expected = claimFor(
					resource,
					await selectComposition(cluster, resource),
				);
				if (claim.specHash !== stableJson(expected.spec)) {
					resources.push({ name: resource.name, reason: "spec-drift" });
				}
				if (claim.status.phase !== "Ready") {
					resources.push({ name: resource.name, reason: "not-ready" });
				}
				// Out-of-band STATUS mutation: compare live status outputs to the
				// snapshot recorded at apply time (appliedOutputs), never to a
				// fabricated expectation.
				if (claim.appliedOutputs) {
					for (const outputName of resource.outputs ?? []) {
						if (
							claim.status.outputs?.[outputName] !==
							claim.appliedOutputs[outputName]
						) {
							resources.push({
								name: resource.name,
								reason: "status-output-drift",
								output: outputName,
							});
						}
					}
				}
			}

			for (const claimName of await cluster.claimNames()) {
				if (!desiredNames.has(claimName)) {
					resources.push({ name: claimName, reason: "extra-claim" });
				}
			}

			return deepFreeze({
				kind: "drift-report",
				provider: "crossplane",
				model: "composite-resource-claim",
				drifted: resources.length > 0,
				resources,
			});
		},
		async destroy(program) {
			const normalized = validateIacProgram(program);
			const resources = {};
			for (const resource of [...normalized.resources].reverse()) {
				const existing = await cluster.getClaim(resource.name);
				resources[resource.name] = {
					id: existing?.id ?? claimId(resource.name),
					status: "destroyed",
					outputs: {},
				};
				await cluster.deleteClaim(resource.name);
			}

			return deepFreeze({
				kind: "outputs",
				provider: "crossplane",
				model: "composite-resource-claim",
				resources,
				stackOutputs: {},
				bindings: {},
			});
		},
	});
}

// The in-memory Crossplane cluster fixture (offline default; promoted from the
// HOBO-188 draft proof). Real CRD/composition/claim semantics — including
// stuck-claim and out-of-band-mutation seams — without a kind/k3d cluster.
export interface InMemoryCrossplaneClusterOptions {
	readonly installedCrds?: readonly string[];
	readonly compositions?: readonly CrossplaneComposition[];
	readonly stuckClaims?: readonly string[];
}

export function createInMemoryCrossplaneCluster(
	options: InMemoryCrossplaneClusterOptions = {},
) {
	const installedCrds = new Set(options.installedCrds ?? REQUIRED_CRDS);
	const compositions = structuredClone(
		options.compositions ?? [
			{ name: "postgres", labels: { port: "database", class: "postgres" } },
			{ name: "redis", labels: { port: "cache", class: "redis" } },
		],
	);
	const stuckClaims = new Set(options.stuckClaims ?? []);
	const claims = new Map();

	return {
		hasCrd(name) {
			return installedCrds.has(name);
		},
		compositions() {
			return structuredClone(compositions);
		},
		applyClaim(claim) {
			const stored = structuredClone(claim);
			if (stuckClaims.has(claim.name)) {
				stored.status.phase = "Pending";
				stored.status.outputs = {};
			}
			// Snapshot the outputs observed at apply time so refresh can detect
			// out-of-band status mutation without fabricating expectations.
			stored.appliedOutputs = structuredClone(stored.status.outputs ?? {});
			claims.set(claim.name, stored);
			return getClaim(claim.name);
		},
		waitForReady(name, pollLimit) {
			const claim = claims.get(name);
			for (let attempt = 0; attempt < pollLimit; attempt += 1) {
				if (claim?.status.phase === "Ready") return true;
			}
			return false;
		},
		getClaim,
		claimNames() {
			return [...claims.keys()].sort();
		},
		deleteClaim(name) {
			claims.delete(name);
		},
		mutateClaim(name, mutation: CrossplaneClaimMutation = {}) {
			const claim = claims.get(name);
			if (!claim) {
				throw new CrossplaneProgramError(
					"claim-not-found",
					`claim ${name} does not exist`,
				);
			}

			if (mutation.specPatch) {
				claim.spec = deepMerge(claim.spec, mutation.specPatch);
				claim.specHash = stableJson(claim.spec);
			}
			if (mutation.statusPatch) {
				claim.status.outputs = {
					...claim.status.outputs,
					...structuredClone(mutation.statusPatch),
				};
			}
			return getClaim(name);
		},
	};

	function getClaim(name) {
		const claim = claims.get(name);
		return claim ? deepFreeze(structuredClone(claim)) : undefined;
	}
}

export function outputsToBindings(outputs) {
	const bindings = {};

	for (const [
		resourceName,
		resource,
	] of Object.entries<CrossplaneResourceOutcome>(outputs.resources ?? {})) {
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
// identical assertion names to the Pulumi and Terraform lanes, so backends
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
			Object.values<CrossplaneResourceOutcome>(destroy.resources).every(
				(resource) => resource.status === "destroyed",
			),
		"destroy-clean",
	);

	return deepFreeze({
		suite: "@hobo/conformance/iac-backend",
		provider: "crossplane",
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

function assertConformance(condition, assertion) {
	if (!condition) {
		throw new CrossplaneApplyError(
			"conformance-failed",
			`IaC backend conformance assertion failed: ${assertion}`,
		);
	}
}

export function validateIacProgram(program) {
	// Parse, don't validate: returns a frozen, derived parsed domain program so
	// callers work with a trusted ParsedIacProgram instead of re-checking DTO fields.
	if (!program || !isJsonObject(program)) {
		throw new CrossplaneProgramError(
			"invalid-program",
			"IacProgram must be an object",
		);
	}
	if (program.apiVersion !== IAC_PROGRAM_API_VERSION) {
		throw new CrossplaneProgramError(
			"invalid-api-version",
			`IacProgram apiVersion must be ${IAC_PROGRAM_API_VERSION}`,
		);
	}
	if (program.kind !== "iac-program") {
		throw new CrossplaneProgramError(
			"invalid-kind",
			"IacProgram kind must be iac-program",
		);
	}
	if (program.provider !== "crossplane") {
		throw new CrossplaneProgramError(
			"invalid-provider",
			"IacProgram provider must be crossplane",
		);
	}
	if (!Array.isArray(program.resources) || program.resources.length === 0) {
		throw new CrossplaneProgramError(
			"empty-program",
			"IacProgram must include resources",
		);
	}

	const resources = new Map();
	for (const resource of program.resources) {
		if (!resource?.name) {
			throw new CrossplaneProgramError(
				"invalid-resource",
				"resource name is required",
			);
		}
		if (resources.has(resource.name)) {
			throw new CrossplaneProgramError(
				"duplicate-resource",
				`IacProgram includes duplicate resource ${resource.name}`,
			);
		}
		resources.set(resource.name, resource);
		if (!resource.inputs?.compositionSelector?.matchLabels) {
			throw new CrossplaneProgramError(
				"missing-composition-selector",
				`${resource.name} must include inputs.compositionSelector.matchLabels`,
			);
		}
	}

	// Resource inputs are where cross-resource references actually live —
	// `resolveValue` substitutes them at apply time — yet only stackOutputs was
	// checked here. A claim referencing a resource that is not in the program,
	// or an output its target does not declare, parsed cleanly and then failed
	// at resolve, deep inside the apply. This walks the resources the way every
	// sibling adapter (iac-terraform, the provider mirrors) does.
	for (const value of collectValues(program.resources)) {
		validateOutputReference(value, resources);
	}
	for (const value of Object.values(program.stackOutputs ?? {})) {
		validateOutputReference(value, resources);
	}

	return deepFreeze(structuredClone(program));
}

function collectValues(value) {
	// Arrays first: `isJsonObject` excludes them by design, so without this
	// branch `program.resources` — itself an array — would come back as one
	// opaque value and nothing inside any resource would be checked. That is
	// the exact bug just fixed in iac-terraform and provider-kubernetes.
	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectValues(entry));
	}
	if (!value || !isJsonObject(value)) {
		return [value];
	}
	return Object.values(value).flatMap((child) => collectValues(child));
}

async function ensureRequiredCrds(cluster: CrossplaneClusterLike) {
	for (const crd of REQUIRED_CRDS) {
		if (!(await cluster.hasCrd(crd))) {
			throw new CrossplaneProgramError(
				"crd-missing",
				`missing required Crossplane CRD ${crd}`,
			);
		}
	}
}

async function selectComposition(cluster: CrossplaneClusterLike, resource) {
	const selector = resource.inputs.compositionSelector.matchLabels;
	const matches = (await cluster.compositions()).filter((composition) =>
		Object.entries(selector).every(
			([key, value]) => composition.labels?.[key] === value,
		),
	);

	if (matches.length === 0) {
		throw new CrossplaneProgramError(
			"composition-not-found",
			`${resource.name} selector matched no Crossplane Composition`,
		);
	}
	if (matches.length > 1) {
		throw new CrossplaneProgramError(
			"composition-ambiguous",
			`${resource.name} selector matched multiple Crossplane Compositions: ${matches
				.map((match) => match.name)
				.sort()
				.join(", ")}`,
		);
	}

	return matches[0];
}

async function diffFor(program, cluster: CrossplaneClusterLike) {
	const desired = new Set(program.resources.map((resource) => resource.name));
	const changes = [];

	for (const resource of program.resources) {
		const expected = claimFor(
			resource,
			await selectComposition(cluster, resource),
		);
		const claim = await cluster.getClaim(resource.name);
		if (!claim) {
			changes.push({
				op: "create",
				resource: resource.name,
				reason: "claim-missing",
			});
			continue;
		}

		if (claim.specHash !== stableJson(expected.spec)) {
			changes.push({
				op: "update",
				resource: resource.name,
				reason: "spec-drift",
			});
		}
	}

	for (const claimName of await cluster.claimNames()) {
		if (!desired.has(claimName)) {
			changes.push({
				op: "delete",
				resource: claimName,
				reason: "extra-claim",
			});
		}
	}

	return deepFreeze({
		kind: "diff",
		provider: "crossplane",
		model: "composite-resource-claim",
		dirty: changes.length > 0,
		changes,
	});
}

export function claimFor(resource, composition) {
	const status = fixtureStatusFor(resource);
	const spec = {
		apiVersion: CROSSPLANE_CLAIM_API_VERSION,
		kind: "CompositeResourceClaim",
		compositionRef: composition.name,
		parameters: structuredClone(resource.inputs.parameters ?? {}),
		resourceType: resource.type,
	};

	return {
		id: claimId(resource.name),
		name: resource.name,
		spec,
		specHash: stableJson(spec),
		status,
	};
}

// Fixture status for the in-memory lane: on a real cluster the controller
// writes status; the kubectl cluster ignores this seed and reads live status.
function fixtureStatusFor(resource) {
	const serviceName =
		resource.name === "database"
			? "postgres"
			: resource.name === "cache"
				? "redis"
				: resource.name;
	return {
		phase: "Ready",
		outputs: {
			endpoint: `${serviceName}.${resource.name}.svc.cluster.local`,
			resourceId: `managed/${resource.name}`,
		},
	};
}

function outputsForClaim(claim, resource) {
	const outputs = {};
	for (const output of resource.outputs ?? []) {
		outputs[output] = claim.status.outputs[output];
	}

	return {
		id: claim.id,
		status: claim.status.phase === "Ready" ? "provisioned" : "pending",
		outputs,
	};
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
	if (!match) return structuredClone(value);

	const [, resourceName, outputName] = match;
	return resources[resourceName].outputs[outputName];
}

function validateOutputReference(value, resources) {
	if (!isJsonString(value) || !value.startsWith("${resources.")) {
		return;
	}

	const match = OUTPUT_REF.exec(value);
	if (!match) {
		throw new CrossplaneProgramError(
			"invalid-output-reference",
			`invalid output reference ${value}`,
		);
	}

	const [, resourceName, outputName] = match;
	const resource = resources.get(resourceName);
	if (!resource || !(resource.outputs ?? []).includes(outputName)) {
		throw new CrossplaneProgramError(
			"unresolved-output-reference",
			`unresolved output reference resources.${resourceName}.outputs.${outputName}`,
		);
	}
}

function claimId(name) {
	return `crossplane:claim:${name}`;
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

function deepMerge(left, right) {
	const merged = structuredClone(left);
	for (const [key, value] of Object.entries(right)) {
		if (isPlainObject(value) && isPlainObject(merged[key])) {
			merged[key] = deepMerge(merged[key], value);
		} else {
			merged[key] = structuredClone(value);
		}
	}
	return merged;
}

function isPlainObject(value) {
	return Boolean(value && isJsonObject(value) && !Array.isArray(value));
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
