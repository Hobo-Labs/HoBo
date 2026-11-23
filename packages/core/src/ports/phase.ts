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

export const REQUEST_SCOPED_CAPABILITIES = Object.freeze([
	"request",
	"reply",
	"requestPrincipal",
	"requestSpan",
] as const);

export const INIT_SCOPED_CAPABILITIES = Object.freeze([
	"bindingClient",
	"instanceState",
] as const);

export type PhaseScopedCapability =
	| (typeof REQUEST_SCOPED_CAPABILITIES)[number]
	| (typeof INIT_SCOPED_CAPABILITIES)[number];

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

export const HOBO_PHASE_ENV = "HOBO_PHASE"; // public-contract: the env-var name hosts and guests agree on
export const HOBO_DEV_ENV = "HOBO_DEV"; // public-contract: the env-var name hosts and guests agree on
export const HOBO_DEV_VALUES = Object.freeze(["0", "1"] as const);

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

export function parseDeploymentPhase(
	value: JsonValue | undefined,
): DeploymentPhase {
	if (
		!isJsonString(value) ||
		!(DEPLOYMENT_PHASES as readonly string[]).includes(value)
	) {
		throw new PhaseParseError(
			"phase",
			DEPLOYMENT_PHASES.join(" | "),
			value,
			`phase: expected ${DEPLOYMENT_PHASES.join(" | ")}; a deployment phase is never defaulted because the wrong default silently admits request state into instance state`,
		);
	}
	return value as DeploymentPhase;
}

export function parsePhaseScope(value: JsonValue | undefined): PhaseScope {
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		throw new PhaseParseError("phaseScope", "object", value);
	}
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

export function phaseForCapability(
	capability: PhaseScopedCapability,
): DeploymentPhase {
	const phase = (
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

export function assertCapabilityPhase(
	scope: PhaseScope,
	capability: PhaseScopedCapability,
): void {
	const requiredPhase = phaseForCapability(capability);
	if (scope.phase !== requiredPhase) {
		throw new PhaseViolationError(capability, requiredPhase, scope.phase);
	}
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
