import {
	type Experimental_CompositionCandidate as Candidate,
	type Experimental_CompositionEvaluator as Evaluator,
	experimental_composeSpec,
	experimental_createEvaluator,
	type Spec,
	validateSpec,
} from "@json-render/core";

import { connectCandidates, OPTIONAL_SUFFIX } from "./candidates.js";
import { connectCatalog } from "./catalog.js";
import { type ConnectStep, providerLabel } from "./steps.js";

// Compose the exact component a step needs.
//
// With an evaluator, json-render's composer (`experimental_composeSpec`) has a
// model choose and arrange the step's candidates — the configured, already
// valid component instances in `candidates.ts` — so the page is generated for
// the step, but can only ever contain HoBo's own components with HoBo's own
// props and actions. Only candidate descriptions and the prompt reach the
// evaluator; props, state and bindings stay here.
//
// Without one, or when composition stops short, `deterministicConnectSpec`
// lays the same candidates out in reading order. Either way the result passes
// `validateSpec` before a browser sees it, so a model's mistake degrades to the
// deterministic page, never to a broken or half-rendered one.

export interface ComposedConnectSpec {
	readonly spec: Spec;
	readonly composedBy: "model" | "deterministic";
	/** Why composition fell back, when it did. */
	readonly fallbackReason: string | undefined;
}

/** The same candidates, in reading order, under the root card. */
export function deterministicConnectSpec(step: ConnectStep): Spec {
	const candidates = connectCandidates(step);
	const rootCandidate = candidates.find((candidate) => candidate.root === true);
	if (rootCandidate === undefined)
		throw new Error(`connect step ${step.kind} has no root candidate`);
	const children = candidates.filter(
		(candidate) =>
			candidate !== rootCandidate &&
			// Of mutually exclusive candidates sharing a resource, all are kept:
			// for a choice (one button per store) the resource only bounds a model.
			!candidate.id.endsWith(OPTIONAL_SUFFIX),
	);
	const optional = candidates.filter((candidate) =>
		candidate.id.endsWith(OPTIONAL_SUFFIX),
	);
	const elements: Spec["elements"] = {
		[rootCandidate.id]: {
			...elementOf(rootCandidate),
			children: [...children, ...optional].map((candidate) => candidate.id),
		},
	};
	for (const candidate of [...children, ...optional])
		elements[candidate.id] = { ...elementOf(candidate), children: [] };
	return { root: rootCandidate.id, elements };
}

function elementOf(candidate: Candidate): Spec["elements"][string] {
	return {
		type: candidate.element.type,
		props: candidate.element.props,
		...(candidate.element.on !== undefined
			? { on: candidate.element.on }
			: undefined),
		...(candidate.element.visible !== undefined
			? { visible: candidate.element.visible }
			: undefined),
	};
}

function promptFor(step: ConnectStep): string {
	const provider = providerLabel(step.provider);
	return `Build the single card a person needs to finish this step of connecting ${provider} (${step.kind}). Lead with the title and the explanation, put the primary action before secondary ones, include every required element, and nothing decorative.`;
}

function fingerprint(element: {
	readonly type: string;
	readonly props: unknown;
	readonly on?: unknown;
}): string {
	return JSON.stringify([element.type, element.props, element.on ?? null]);
}

/** Required (non-optional) candidates absent from a composed spec, by id. */
export function missingRequiredCandidates(
	step: ConnectStep,
	spec: Spec,
): string[] {
	const present = new Set(Object.values(spec.elements).map(fingerprint));
	return connectCandidates(step)
		.filter((candidate) => !candidate.id.endsWith(OPTIONAL_SUFFIX))
		.filter((candidate) => !present.has(fingerprint(candidate.element)))
		.map((candidate) => candidate.id);
}

/** Valid against the catalog's components and structurally sound. */
export function isRenderableConnectSpec(spec: Spec): boolean {
	if (!validateSpec(spec, { checkOrphans: true }).valid) return false;
	const known = new Set(Object.keys(connectCatalog.data.components));
	return Object.values(spec.elements).every((element) =>
		known.has(element.type),
	);
}

export interface ComposeOptions {
	readonly evaluate?: Evaluator | undefined;
	readonly signal?: AbortSignal;
}

/** Compose a step's page: model-arranged when an evaluator is given. */
export async function composeConnectSpec(
	step: ConnectStep,
	options: ComposeOptions = {},
): Promise<ComposedConnectSpec> {
	const fallback = (reason: string | undefined): ComposedConnectSpec => ({
		spec: deterministicConnectSpec(step),
		composedBy: "deterministic",
		fallbackReason: reason,
	});
	if (options.evaluate === undefined) return fallback(undefined);
	try {
		let composed: Spec | null = null;
		let stopReason = "unavailable";
		for await (const event of experimental_composeSpec({
			catalog: connectCatalog,
			candidates: connectCandidates(step),
			prompt: promptFor(step),
			evaluate: options.evaluate,
			maxSteps: 8,
			maxElements: 16,
			...(options.signal !== undefined
				? { signal: options.signal }
				: undefined),
		})) {
			if (event.type === "complete") {
				composed = event.spec;
				stopReason = event.stopReason;
			}
		}
		if (composed === null || stopReason !== "finish")
			return fallback(`composition stopped: ${stopReason}`);
		if (!isRenderableConnectSpec(composed))
			return fallback("composed spec failed validation");
		// Structural validation cannot see omitted content: a model that drops
		// the step's action would leave the person stranded. Every required
		// candidate must be in the page, or the deterministic page is used.
		const missing = missingRequiredCandidates(step, composed);
		if (missing.length > 0)
			return fallback(`composed spec omitted ${missing.join(", ")}`);
		return { spec: composed, composedBy: "model", fallbackReason: undefined };
	} catch (error) {
		return fallback(
			`composition failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * The evaluator the environment configures, if any. Secretless first: on
 * Vercel (or after `vercel env pull`) the short-lived `VERCEL_OIDC_TOKEN`
 * authenticates to AI Gateway; `AI_GATEWAY_API_KEY` is the fallback. With
 * neither, pages are composed deterministically. `HOBO_CONNECT_UI_COMPOSE=off`
 * turns the model off even when a credential is present.
 */
export function evaluatorFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	fetchImpl?: typeof fetch,
): Evaluator | undefined {
	if (env.HOBO_CONNECT_UI_COMPOSE === "off") return undefined;
	const apiKey = env.VERCEL_OIDC_TOKEN || env.AI_GATEWAY_API_KEY;
	if (!apiKey) return undefined;
	return experimental_createEvaluator({
		apiKey,
		model: env.HOBO_CONNECT_UI_MODEL || "typesafe-ai/jev",
		timeoutMs: 10_000,
		...(fetchImpl !== undefined ? { fetch: fetchImpl } : undefined),
	});
}
