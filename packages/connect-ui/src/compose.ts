import {
	type Experimental_CompositionCandidate as Candidate,
	type Experimental_CompositionEvaluator as Evaluator,
	experimental_composeSpec,
	experimental_createEvaluator,
	type Spec,
	validateSpec,
} from "@json-render/core";
import { z } from "zod";

import { connectCandidates, OPTIONAL_SUFFIX } from "./candidates.js";
import { connectCatalog } from "./catalog.js";
import { type ConnectStep, providerLabel } from "./steps.js";

export interface ComposedConnectSpec {
	readonly spec: Spec;
	readonly composedBy: "model" | "deterministic";
	readonly fallbackReason: string | undefined;
}

export function deterministicConnectSpec(step: ConnectStep): Spec {
	const candidates = connectCandidates(step);
	const rootCandidate = candidates.find((candidate) => candidate.root === true);
	if (rootCandidate === undefined)
		throw new Error(`connect step ${step.kind} has no root candidate`);
	const children = candidates.filter(
		(candidate) =>
			candidate !== rootCandidate && !candidate.id.endsWith(OPTIONAL_SUFFIX),
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

const BindStateMarker = z.object({ $bindState: z.string() });

function fingerprint(element: {
	readonly type: string;
	readonly props: unknown;
	readonly on?: unknown;
	readonly visible?: unknown;
}): string {
	const propsParsed = z
		.record(z.string(), z.unknown())
		.safeParse(element.props);
	const props = propsParsed.success
		? {
				...propsParsed.data,
				value: BindStateMarker.safeParse(propsParsed.data.value).success
					? { bound: true }
					: propsParsed.data.value,
			}
		: element.props;
	return JSON.stringify([
		element.type,
		props,
		element.on ?? null,
		element.visible ?? null,
	]);
}

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

const PressBindingSchema = z.object({
	press: z.object({ action: z.string() }),
});

export function isRenderableConnectSpec(spec: Spec): boolean {
	if (!validateSpec(spec, { checkOrphans: true }).valid) return false;
	const knownComponents = new Set(Object.keys(connectCatalog.data.components));
	const knownActions = new Set(Object.keys(connectCatalog.data.actions));
	for (const element of Object.values(spec.elements)) {
		if (!knownComponents.has(element.type)) return false;
		const press = PressBindingSchema.safeParse(element.on);
		if (press.success && !knownActions.has(press.data.press.action))
			return false;
	}
	return true;
}

export interface ComposeOptions {
	readonly evaluate?: Evaluator | undefined;
	readonly signal?: AbortSignal;
}

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

export function evaluatorFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	fetchImpl?: typeof fetch,
): Evaluator | undefined {
	const apiKey = env.VERCEL_OIDC_TOKEN || env.AI_GATEWAY_API_KEY;
	if (env.HOBO_CONNECT_UI_COMPOSE !== "on") return undefined;
	if (!apiKey) return undefined;
	return experimental_createEvaluator({
		apiKey,
		model: env.HOBO_CONNECT_UI_MODEL || "typesafe-ai/jev",
		timeoutMs: 10_000,
		...(fetchImpl !== undefined ? { fetch: fetchImpl } : undefined),
	});
}
