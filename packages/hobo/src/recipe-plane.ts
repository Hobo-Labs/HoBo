import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createConnectivityRegistry,
	STANDARD_CONNECTIVITY,
} from "@hobo/bindings";
import type { BindleDefinition } from "@hobo/bindles";
import type {
	BindlePrimitive,
	SelectionCandidate,
} from "@hobo/capability-profiles";
import {
	BINDLE_PRIMITIVES,
	createCapabilityProfileRegistry,
	isBindleRuntime,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	tryParseProfileId,
} from "@hobo/capability-profiles";
import type { YardRuntime } from "@hobo/cli";
import {
	profileCatalogHash,
	type ResourceDefinitionVNext,
	toSelectionCandidate,
} from "@hobo/cloud";
import {
	type BindleCapabilityRequest,
	type CapabilityDependency,
	compileRecipe,
	DEFAULT_RECIPE_POLICY,
	type DeploymentRequest,
	findStandardRecipe,
	parseDeploymentRequest,
	type RecipeCompilationAccepted,
	type RecipeSemantics,
	type SolutionRecipe,
	STANDARD_SOLUTION_RECIPES,
} from "@hobo/recipes";
import {
	DEFAULT_TRUST_REQUIREMENT,
	type EvidenceVerifier,
	parseTrustEvidence,
	type TrustEvidence,
} from "@hobo/trust";
import { FIRST_PARTY_DEFINITIONS } from "./first-party-catalog.js";
import { isJsonObject } from "./json.js";
import { stationEvidenceVerifier } from "./trust-root.js";

// The composition root for the anonymous deployment plane.
//
// `@hobo/recipes` owns no catalog and reads no clock, by design: it takes a
// projected catalog, a profile registry, connectivity, evidence, and an
// instant. This module is where those come from in the CLI — the same live,
// approval-gated registry the Planner matches over, the first-party profile
// and connectivity registries, and trust evidence published by the live
// conformance harness.
//
// Evidence is read from disk rather than compiled in on purpose. Evidence
// expires; a build-time constant would let a stale attestation outlive the
// run that produced it.

/** Where published trust evidence lives, relative to `HOBO_HOME`. */
// public-contract: operators and evidence publishers share this directory name.
export const EVIDENCE_DIRECTORY = "evidence";

export class RecipePlaneError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RecipePlaneError";
		this.code = code;
	}
}

export interface RecipeCatalogSnapshot {
	readonly candidates: readonly SelectionCandidate[];
	readonly catalogDigest: string;
}

/**
 * Project the live registry into selection shape.
 *
 * A definition without a `semantics` block is not promoted: a legacy product
 * keeps matching through its original port path and never silently becomes
 * claimable or profile-conformant.
 */
export function projectCatalog(
	definitions: readonly ResourceDefinitionVNext[],
	profiles: ReturnType<typeof createCapabilityProfileRegistry>,
): RecipeCatalogSnapshot {
	const candidates: SelectionCandidate[] = [];
	for (const definition of definitions) {
		const candidate = toSelectionCandidate(definition);
		if (candidate !== undefined) {
			candidates.push(candidate);
		}
	}
	candidates.sort((left, right) =>
		left.definitionId.localeCompare(right.definitionId),
	);
	return {
		candidates,
		catalogDigest: profileCatalogHash(definitions, profiles),
	};
}

/**
 * Read published trust evidence.
 *
 * A malformed artifact is an error rather than a skipped file: silently
 * ignoring an unparseable attestation would let a provider lose its evidence
 * and keep its ranking.
 */
export async function loadTrustEvidence(
	directory: string,
): Promise<readonly TrustEvidence[]> {
	let entries: readonly string[];
	try {
		entries = await readdir(directory);
	} catch (cause) {
		// SAFETY: assertion required at this I/O or test boundary.
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw new RecipePlaneError(
			"evidence-unreadable",
			`evidence-unreadable: cannot read ${directory}`,
			{ cause },
		);
	}
	const evidence: TrustEvidence[] = [];
	for (const entry of [...entries].sort()) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const path = join(directory, entry);
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(await readFile(path, "utf8"));
		} catch (cause) {
			throw new RecipePlaneError(
				"evidence-unreadable",
				`evidence-unreadable: ${entry} is not valid JSON`,
				{ cause },
			);
		}
		// The live harness publishes a signed artifact that wraps the evidence
		// alongside its provenance; a hand-exported document is the evidence
		// itself. Both are legitimate on disk, so unwrap when wrapped.
		const document =
			isJsonObject(parsedJson) && parsedJson.evidence !== undefined
				? parsedJson.evidence
				: parsedJson;
		try {
			// SAFETY: assertion required at this I/O or test boundary.
			evidence.push(parseTrustEvidence(document as never));
		} catch (cause) {
			throw new RecipePlaneError(
				"evidence-invalid",
				`evidence-invalid: ${entry} is not a trust-evidence artifact`,
				{ cause },
			);
		}
	}
	return evidence;
}

export interface RecipeContext {
	readonly catalog: RecipeCatalogSnapshot;
	readonly evidence: readonly TrustEvidence[];
	/**
	 * The Station's trust roots, as a verifier.
	 *
	 * Present even when no root is configured: that verifier answers `unknown`
	 * for everything, so an operator who never said whose attestations they
	 * accept selects nothing rather than everything.
	 */
	readonly verifier: EvidenceVerifier;
	readonly registry: ReturnType<typeof createCapabilityProfileRegistry>;
	readonly connectivity: ReturnType<typeof createConnectivityRegistry>;
	readonly profileRegistryDigest: string;
}

export interface BuildRecipeContextInput {
	readonly definitions: readonly ResourceDefinitionVNext[];
	readonly evidenceDirectory: string;
	/** Station home holding `trust-roots/`. */
	readonly home: string;
}

export async function buildRecipeContext(
	input: BuildRecipeContextInput,
): Promise<RecipeContext> {
	const registry = createCapabilityProfileRegistry(
		STANDARD_CAPABILITY_PROFILES,
	);
	return {
		catalog: projectCatalog(input.definitions, registry),
		evidence: await loadTrustEvidence(input.evidenceDirectory),
		verifier: await stationEvidenceVerifier(input.home),
		registry,
		connectivity: createConnectivityRegistry(STANDARD_CONNECTIVITY),
		profileRegistryDigest: registry.digest,
	};
}

/**
 * Every definition selection can see, in a stable order.
 *
 * Two sources, deliberately: the first-party catalog compiled into the binary,
 * and whatever the durable registry stream has since registered and approved
 * (`hobo add`). The stream wins on a collision, because an operator who
 * re-registers a product id is overriding the shipped default on purpose.
 */
export function definitionsOf(
	runtime: YardRuntime,
): readonly ResourceDefinitionVNext[] {
	const registered =
		// SAFETY: assertion required at this I/O or test boundary.
		runtime.registry.definitions() as readonly ResourceDefinitionVNext[];
	const byId = new Map<string, ResourceDefinitionVNext>();
	for (const definition of FIRST_PARTY_DEFINITIONS)
		byId.set(definition.id, definition);
	for (const definition of registered) byId.set(definition.id, definition);
	return [...byId.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

export interface RecipeSummary {
	readonly recipeId: string;
	readonly title: string;
	readonly providerIds: readonly string[];
	readonly yardCount: number;
	readonly claimActionCount: number;
	readonly bootstrapClasses: readonly string[];
	readonly sponsored: boolean;
	readonly sourceDisclosure: string;
	readonly credentialCustody: string;
}

/** The read-only view `hobo recipes list` renders. */
export function summarizeRecipe(recipe: SolutionRecipe): RecipeSummary {
	const providerIds = [
		...new Set(recipe.yards.map((yard) => yard.providerId)),
	].sort();
	const bootstrapClasses = [
		...new Set(recipe.yards.map((yard) => yard.lease.bootstrapClass)),
	].sort();
	return {
		recipeId: recipe.id,
		title: recipe.displayName,
		providerIds,
		yardCount: recipe.yards.length,
		claimActionCount: recipe.placements.reduce(
			(total, placement) => total + placement.claim.actionCount,
			0,
		),
		bootstrapClasses,
		sponsored: recipe.yards.some((yard) => yard.sponsored),
		sourceDisclosure: recipe.bootstrap.sourceDisclosure,
		credentialCustody: recipe.delivers.credentialCustody,
	};
}

export function listRecipeSummaries(): readonly RecipeSummary[] {
	return STANDARD_SOLUTION_RECIPES.map(summarizeRecipe);
}

/**
 * Re-exported so callers that must name the type — a `let` awaiting a
 * `requireRecipe` call inside a try, for instance — can do so without
 * reaching past this plane into `@hobo/recipes` directly.
 */
export type { SolutionRecipe };

export function requireRecipe(recipeId: string): SolutionRecipe {
	const recipe = findStandardRecipe(recipeId);
	if (recipe === undefined) {
		throw new RecipePlaneError(
			"unknown-recipe",
			`unknown-recipe: no standard recipe is registered as ${recipeId}`,
		);
	}
	return recipe;
}

/**
 * Read a project's provider-neutral Bindle as a deployment request.
 *
 * Profile intent lives in the Bindle's `require`/`prefer` lists, and profile
 * ids are namespaced by primitive (`data.postgres/v1`), so each resource takes
 * the requirements that name its own primitive. A resource whose primitive
 * nobody constrained asks only for its base primitive profile, which is what
 * "any relational store will do" looks like in this model.
 */
export function deploymentRequestFromBindle(
	definition: BindleDefinition,
	deploymentRef: string,
	requestedSemantics: RecipeSemantics,
): DeploymentRequest {
	const byPrimitive = new Map<
		BindlePrimitive,
		{ required: string[]; preferred: string[] }
	>();
	const bucket = (primitive: BindlePrimitive) => {
		const existing = byPrimitive.get(primitive);
		if (existing !== undefined) return existing;
		// SAFETY: assertion required at this I/O or test boundary.
		const created = { required: [] as string[], preferred: [] as string[] };
		byPrimitive.set(primitive, created);
		return created;
	};
	for (const value of definition.requirements.require) {
		const parsed = tryParseProfileId(value);
		if (parsed !== undefined) bucket(parsed.primitive).required.push(parsed.id);
	}
	for (const value of definition.requirements.prefer) {
		const parsed = tryParseProfileId(value);
		if (parsed !== undefined)
			bucket(parsed.primitive).preferred.push(parsed.id);
	}
	const runtimes = definition.requirements.runtimes.filter((value) =>
		isBindleRuntime(value),
	);

	const capabilities: BindleCapabilityRequest[] = [];
	const dependencies: CapabilityDependency[] = [];
	for (const resource of Object.values(definition.resources)) {
		if (!isBindlePrimitive(resource.kind)) {
			continue;
		}
		const primitive = resource.kind;
		const intent = byPrimitive.get(primitive);
		const required =
			intent !== undefined && intent.required.length > 0
				? intent.required
				: [`${primitive}.${BASE_PROFILE_PATH[primitive]}/v1`];
		capabilities.push({
			capabilityRef: resource.name,
			primitive,
			requirement: parseCapabilityRequirement({
				requiredProfiles: required.map((profileId) => ({ profileId })),
				preferredProfiles: (intent?.preferred ?? []).map((profileId) => ({
					profileId,
					weight: 1,
				})),
				...(runtimes.length > 0
					? { runtime: { allowed: runtimes } }
					: undefined),
			}),
		});
		for (const dependency of resource.dependsOn) {
			dependencies.push({
				fromCapabilityRef: resource.name,
				toCapabilityRef: dependency,
			});
		}
	}

	const declared = new Set(
		capabilities.map((capability) => capability.capabilityRef),
	);
	return parseDeploymentRequest({
		deploymentRef,
		capabilities,
		dependencies: dependencies.filter(
			(dependency) =>
				declared.has(dependency.fromCapabilityRef) &&
				declared.has(dependency.toCapabilityRef),
		),
		requestedSemantics,
	});
}

/**
 * The profile a primitive asks for when the Bindle named no narrower one.
 * These are the base profiles in the standard registry, so an unconstrained
 * request stays satisfiable rather than resolving to nothing.
 */
const BASE_PROFILE_PATH = {
	web: "static",
	api: "http",
	service: "worker",
	data: "relational",
	kv: "key-value",
	bucket: "object",
	queue: "at-least-once",
	topic: "pubsub",
	secretRef: "uri",
	webhook: "http",
};

function isBindlePrimitive(value: string): value is BindlePrimitive {
	// SAFETY: assertion required at this I/O or test boundary.
	return (BINDLE_PRIMITIVES as readonly string[]).includes(value);
}

export interface CompileOfferTopologyInput {
	readonly recipe: SolutionRecipe;
	readonly request: DeploymentRequest;
	readonly context: RecipeContext;
	readonly nowMs: number;
}

/**
 * Compile a recipe against the live catalog.
 *
 * Rejections are returned rather than thrown: "no candidate has fresh evidence
 * for `data.postgres/v1`" is an answer the caller must be able to render, not
 * an exception to swallow.
 */
export function compileTopology(input: CompileOfferTopologyInput) {
	return compileRecipe({
		recipe: input.recipe,
		request: input.request,
		registry: input.context.registry,
		catalog: input.context.catalog.candidates,
		catalogDigest: input.context.catalog.catalogDigest,
		connectivity: input.context.connectivity,
		policy: DEFAULT_RECIPE_POLICY,
		trustRequirement: DEFAULT_TRUST_REQUIREMENT,
		evidence: input.context.evidence,
		verifier: input.context.verifier,
		nowMs: input.nowMs,
	});
}

export function isAcceptedCompilation(
	compilation: ReturnType<typeof compileTopology>,
): compilation is RecipeCompilationAccepted {
	return compilation.ok;
}
