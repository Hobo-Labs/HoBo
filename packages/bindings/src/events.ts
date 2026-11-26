/**
 * The `binding.*` event family — exactly three facts, and deliberately no more.
 *
 * `binding.Resolved` is the plan-phase decision per workload edge.
 * `binding.Projected` is the deploy-time wiring of a resolved binding into a
 * workload through its connectivity implementation. `binding.Unavailable` is
 * the fail-closed refusal, and it always carries remediation.
 *
 * Two absences are load-bearing:
 *
 * 1. **There is no `binding.Declared`.** Yard binding row state rides
 *    `yard.Registered` (ADR-0157). A declaration event would duplicate row
 *    state into a second stream, and two writers of the same fact is how an
 *    audit trail starts disagreeing with itself.
 * 2. **Per-activation client construction emits nothing.** `binding.Projected`
 *    records deploy-time wiring only. Building the typed `ctx.bindings.<alias>`
 *    client during an ADR-0158 `init` is a hot path; a control-plane write per
 *    activation would cost real latency and buy no audit value, because the
 *    wiring it would describe was already recorded at deploy time.
 *
 * Facts are frozen at both levels, carry their own name, copy incoming arrays,
 * and are screened for secret-shaped values — an event stream is the most
 * widely replicated surface in the system, so a credential leaked into one is
 * a credential leaked everywhere.
 */

import type { ConnectivityImplementation } from "./binding.js";
import {
	assertCount,
	assertMember,
	assertNonSecretField,
	BINDING_UNAVAILABLE_CODES,
	BindingRecordError,
	type BindingResolution,
	type BindingUnavailableCode,
	parseBindingResolution,
} from "./resolution.js";

export const BINDING_EVENT_SCHEMA_VERSION = "hobo.binding-events/v1"; // public-contract: envelope version readers dispatch on

export const BINDING_EVENTS = Object.freeze([
	"binding.Resolved",
	"binding.Projected",
	"binding.Unavailable",
] as const);

export type BindingEventName = (typeof BINDING_EVENTS)[number];

/**
 * How a binding reaches the workload. Kept in step with
 * `ConnectivityImplementation["projection"]` by construction: the `satisfies`
 * clause fails to compile if the two vocabularies drift apart.
 */
export const BINDING_PROJECTIONS = Object.freeze([
	"provider-binding",
	"environment-secret-ref",
	"service-binding-files",
	"wasi-config",
	"in-process",
] as const satisfies readonly ConnectivityImplementation["projection"][]);

export type BindingProjectionKind = (typeof BINDING_PROJECTIONS)[number];

/**
 * Canonical, human-actionable remediation per refusal code. A refusal without
 * remediation is a dead end for the operator, so the text that names what to
 * change lives next to the code rather than being reinvented at each call site.
 */
export const BINDING_UNAVAILABLE_REMEDIATION: Readonly<
	Record<BindingUnavailableCode, string>
> = Object.freeze({
	YARD_BINDING_PRODUCT_UNKNOWN:
		"the Yard binding row names a product this Yard's catalog does not contain; correct the productId in the row, or remove the row to let selection choose",
	YARD_BINDING_PROVIDER_MISMATCH:
		"the product named by the Yard binding row belongs to a different provider than the Yard; move the row to the Yard for that provider, or name a product this provider offers",
	YARD_BINDING_EXCLUDED_ALL:
		"the Yard binding rows for this profile excluded every otherwise-eligible candidate; relax or delete the narrowest row, or add a product that satisfies the profile to this Yard",
	NO_COMPATIBLE_BINDING:
		"no connectivity implementation consumes this binding profile for the workload's runtime model; choose a runtime model this product supports, or add a connectivity implementation that bridges them",
});

export interface BindingFact<
	TName extends BindingEventName,
	TData extends object,
> {
	readonly type: TName;
	readonly schemaVersion: typeof BINDING_EVENT_SCHEMA_VERSION;
	readonly data: Readonly<TData>;
}

export interface BindingProjectedData {
	readonly yardId: string;
	readonly alias: string;
	readonly bindingProfileRef: string;
	readonly connectivityId: string;
	readonly projection: BindingProjectionKind;
}

export interface BindingUnavailableData {
	readonly yardId: string;
	readonly profile: string;
	readonly code: BindingUnavailableCode;
	readonly remediation: string;
	readonly consideredCount: number;
}

export type BindingResolvedEvent = BindingFact<
	"binding.Resolved",
	BindingResolution
>;
export type BindingProjectedEvent = BindingFact<
	"binding.Projected",
	BindingProjectedData
>;
export type BindingUnavailableEvent = BindingFact<
	"binding.Unavailable",
	BindingUnavailableData
>;

export type BindingEvent =
	| BindingResolvedEvent
	| BindingProjectedEvent
	| BindingUnavailableEvent;

/** The frozen-fact constructor every event in this module goes through. */
function fact<TName extends BindingEventName, TData extends object>(
	type: TName,
	data: TData,
): BindingFact<TName, TData> {
	return Object.freeze({
		type,
		schemaVersion: BINDING_EVENT_SCHEMA_VERSION,
		data: Object.freeze(data),
	});
}

/** Plan-phase: this profile is satisfied by this product over this connectivity. */
export function bindingResolved(
	input: BindingResolution,
): BindingResolvedEvent {
	// parseBindingResolution copies and canonicalizes appliedRows, so the fact
	// never aliases a caller-held array.
	return fact("binding.Resolved", parseBindingResolution(input));
}

/**
 * Deploy-time wiring only. This is emitted once when the graph is deployed and
 * the binding is projected into the workload — never per activation. See the
 * module comment: a per-activation write into the control-plane log is a
 * hot-path cost with no audit value.
 */
export function bindingProjected(input: {
	readonly yardId: string;
	readonly alias: string;
	readonly bindingProfileRef: string;
	readonly connectivityId: string;
	readonly projection: BindingProjectionKind;
}): BindingProjectedEvent {
	return fact("binding.Projected", {
		yardId: assertNonSecretField("yardId", input.yardId),
		alias: assertNonSecretField("alias", input.alias),
		bindingProfileRef: assertNonSecretField(
			"bindingProfileRef",
			input.bindingProfileRef,
		),
		connectivityId: assertNonSecretField(
			"connectivityId",
			input.connectivityId,
		),
		projection: assertMember(
			"projection",
			input.projection,
			BINDING_PROJECTIONS,
		),
	});
}

/** Fail-closed refusal. Never constructible without remediation text. */
export function bindingUnavailable(input: {
	readonly yardId: string;
	readonly profile: string;
	readonly code: BindingUnavailableCode;
	readonly remediation: string;
	readonly consideredCount: number;
}): BindingUnavailableEvent {
	const code = assertMember("code", input.code, BINDING_UNAVAILABLE_CODES);
	if (
		input.remediation !== String(input.remediation) ||
		input.remediation.trim().length === 0
	) {
		throw new BindingRecordError(
			"BINDING_RECORD_REMEDIATION_MISSING",
			`binding.Unavailable ${code} must carry remediation naming what to change; BINDING_UNAVAILABLE_REMEDIATION holds the canonical text`,
		);
	}
	// A row-exclusion refusal that considered nothing is incoherent: rows can
	// only exclude candidates that existed to be excluded.
	const minimumConsidered = code === "YARD_BINDING_EXCLUDED_ALL" ? 1 : 0;
	return fact("binding.Unavailable", {
		yardId: assertNonSecretField("yardId", input.yardId),
		profile: assertNonSecretField("profile", input.profile),
		code,
		remediation: assertNonSecretField("remediation", input.remediation),
		consideredCount: assertCount(
			"consideredCount",
			input.consideredCount,
			minimumConsidered,
		),
	});
}
