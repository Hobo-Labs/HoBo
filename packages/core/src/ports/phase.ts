/**
 * Deployment phases (ADR-0158): the shared vocabulary plus the enforcement
 * primitives that make "when may I touch this?" a parse-time answer instead of
 * a runtime surprise.
 *
 * A deployment moves through three phases — `plan` (build the desired graph,
 * no live resources), `init` (module top-level: bindings are wired, clients are
 * constructed once per instance) and `handle` (per-request work). Touching a
 * request-scoped capability during `init` is the classic host bug: it captures
 * one request's state into instance state and leaks it across every subsequent
 * request. Touching an init-scoped capability during `handle` is the mirror
 * bug: per-request client construction on the hot path. Both are refused here
 * with a typed `PhaseViolationError` naming the capability and the phase it
 * belongs to.
 *
 * Dev is a MODE, not a phase (ADR-0158 §2): `hobo dev` runs phase `plan` then
 * `init` with `dev: true`. Modelling dev as a fourth phase would let a dev-only
 * affordance masquerade as a phase-legal one. `dev` therefore rides alongside
 * the phase and never changes which capabilities a phase admits.
 *
 * This module ships vocabulary + enforcement + parse boundaries only. It does
 * NOT ship a handler pipeline: `@hobo/runtime` has no handler surface today and
 * inventing one here would be an overclaim (design-review correction 6).
 */

import { CoreParseError } from "../errors.js";
import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

// public-contract: the closed phase vocabulary hosts and manifests share.
export const DEPLOYMENT_PHASES = Object.freeze([
	"plan",
	"init",
	"handle",
] as const);
export type DeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];

/** Capabilities that exist only while a single request is in flight. */
export const REQUEST_SCOPED_CAPABILITIES = Object.freeze([
	"request",
	"reply",
	"requestPrincipal",
	"requestSpan",
] as const);

/** Capabilities that exist only while an instance is being initialized. */
export const INIT_SCOPED_CAPABILITIES = Object.freeze([
	"bindingClient",
	"instanceState",
] as const);

export type PhaseScopedCapability =
	| (typeof REQUEST_SCOPED_CAPABILITIES)[number]
	| (typeof INIT_SCOPED_CAPABILITIES)[number];

/** Every phase-scoped capability, id-sorted for stable enumeration. */
export const PHASE_SCOPED_CAPABILITIES: readonly PhaseScopedCapability[] =
	Object.freeze(
		[...REQUEST_SCOPED_CAPABILITIES, ...INIT_SCOPED_CAPABILITIES].sort(compare),
	);

const CAPABILITY_PHASES: Readonly<
	Record<PhaseScopedCapability, DeploymentPhase>
> = Object.freeze({
	bindingClient: "init",
	instanceState: "init",
	reply: "handle",
	request: "handle",
	requestPrincipal: "handle",
	requestSpan: "handle",
} as const);

/** Environment-variable contract hosts use to publish the active phase. */
export const HOBO_PHASE_ENV = "HOBO_PHASE"; // public-contract: the env-var name hosts and guests agree on
/** Environment-variable contract hosts use to publish dev mode: "1" | "0". */
export const HOBO_DEV_ENV = "HOBO_DEV"; // public-contract: the env-var name hosts and guests agree on
export const HOBO_DEV_VALUES = Object.freeze(["0", "1"] as const);

/**
 * Dev is a MODE, not a phase (ADR-0158 §2). `hobo dev` runs phase "plan" then
 * "init" with dev=true.
 */
export interface PhaseScope {
	readonly phase: DeploymentPhase;
	readonly dev: boolean;
}

export class PhaseParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_PHASE_PARSE", path, expected, received, message);
		this.name = "PhaseParseError";
	}
}

/** Raised when a phase-scoped capability is touched outside its phase. */
export class PhaseViolationError extends Error {
	readonly code = "PHASE_VIOLATION" as const;
	readonly capability: PhaseScopedCapability;
	readonly requiredPhase: DeploymentPhase;
	readonly actualPhase: DeploymentPhase;

	constructor(
		capability: PhaseScopedCapability,
		requiredPhase: DeploymentPhase,
		actualPhase: DeploymentPhase,
	) {
		super(
			`capability "${capability}" is only available in deployment phase "${requiredPhase}", but the current phase is "${actualPhase}": move the access into the "${requiredPhase}" phase`,
		);
		this.name = "PhaseViolationError";
		this.capability = capability;
		this.requiredPhase = requiredPhase;
		this.actualPhase = actualPhase;
	}
}

/** Parse boundary for a phase token. Unknown values fail closed — no default. */
export function parseDeploymentPhase(
	value: JsonValue | undefined,
): DeploymentPhase {
	if (
		!isJsonString(value) ||
		// SAFETY: assertion required at this I/O or test boundary.
		!(DEPLOYMENT_PHASES as readonly string[]).includes(value)
	) {
		throw new PhaseParseError(
			"phase",
			DEPLOYMENT_PHASES.join(" | "),
			value,
			`phase: expected ${DEPLOYMENT_PHASES.join(" | ")}; a deployment phase is never defaulted because the wrong default silently admits request state into instance state`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as DeploymentPhase;
}

/** Parse boundary for `{ phase, dev }`. Returns a frozen derived record. */
export function parsePhaseScope(value: JsonValue | undefined): PhaseScope {
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		throw new PhaseParseError("phaseScope", "object", value);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const source = value as JsonObject;
	for (const key of Object.keys(source)) {
		if (key !== "phase" && key !== "dev") {
			throw new PhaseParseError("phaseScope", "only keys phase, dev", key);
		}
	}
	if (!isJsonBoolean(source.dev)) {
		throw new PhaseParseError("phaseScope.dev", "boolean", source.dev);
	}
	return Object.freeze({
		phase: parseDeploymentPhase(source.phase),
		dev: source.dev,
	});
}

/**
 * Parse boundary for the host environment contract. An unrecognized value fails
 * closed rather than defaulting: a wrong phase is worse than a refusal. A
 * missing `HOBO_DEV` reads as `false` — absence must never *grant* the extra
 * affordances dev mode carries.
 */
export function parsePhaseScopeFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): PhaseScope {
	const rawPhase = env[HOBO_PHASE_ENV];
	if (rawPhase === undefined) {
		throw new PhaseParseError(
			HOBO_PHASE_ENV,
			DEPLOYMENT_PHASES.join(" | "),
			undefined,
			`${HOBO_PHASE_ENV} is required: set it to ${DEPLOYMENT_PHASES.join(" | ")} — the phase is never inferred`,
		);
	}
	const rawDev = env[HOBO_DEV_ENV];
	if (
		rawDev !== undefined &&
		// SAFETY: assertion required at this I/O or test boundary.
		!(HOBO_DEV_VALUES as readonly string[]).includes(rawDev)
	) {
		throw new PhaseParseError(
			HOBO_DEV_ENV,
			HOBO_DEV_VALUES.join(" | "),
			rawDev,
			`${HOBO_DEV_ENV}: expected ${HOBO_DEV_VALUES.join(" | ")}`,
		);
	}
	return Object.freeze({
		phase: parseDeploymentPhase(rawPhase),
		dev: rawDev === "1",
	});
}

/** The single phase in which `capability` is legal to touch. */
export function phaseForCapability(
	capability: PhaseScopedCapability,
): DeploymentPhase {
	const phase =
		// SAFETY: assertion required at this I/O or test boundary.
		(
			CAPABILITY_PHASES as Readonly<Record<string, DeploymentPhase | undefined>>
		)[capability];
	if (phase === undefined) {
		throw new PhaseParseError(
			"capability",
			PHASE_SCOPED_CAPABILITIES.join(" | "),
			capability,
		);
	}
	return phase;
}

/** Throws PhaseViolationError when `capability` is touched outside its phase. */
export function assertCapabilityPhase(
	scope: PhaseScope,
	capability: PhaseScopedCapability,
): void {
	const requiredPhase = phaseForCapability(capability);
	if (scope.phase !== requiredPhase) {
		throw new PhaseViolationError(capability, requiredPhase, scope.phase);
	}
}

/** Code-unit comparison: locale-independent so ordering is reproducible. */
function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
