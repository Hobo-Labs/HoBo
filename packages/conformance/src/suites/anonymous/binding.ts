/**
 * Binding conformance — is the thing the product hands a workload portable and
 * secretless?
 *
 * The binding is where the ownership story usually leaks: a "connection string"
 * with the password inline is not a credential reference, and a rotation that
 * mints a brand new resource identity is not a rotation. This suite drives the
 * real `@hobo/bindings` parse boundary rather than re-implementing its rules,
 * so a product that satisfies the suite satisfies the boundary the planner and
 * the receipt use.
 */

import {
	type CapabilityBinding,
	type CapabilityBindingInput,
	parseCapabilityBinding,
	parseSecretRef,
	tryParseSecretRef,
} from "@hobo/bindings";
import type { JsonValue } from "../../json.js";

import {
	type AnonymousSuiteDefinition,
	type CaseJudgement,
	optionalMember,
	requireRecord,
	requireText,
} from "./harness.js";
import { type AnonymousCase, AnonymousConformanceError } from "./types.js";

// public-contract: stable suite identifier used in evidence and reports.
export const BINDING_SUITE_ID = "hobo.anonymous.binding/v1";

export const BINDING_CHECKS = {
	roundTrip: "binding.round-trip",
	endpointsNonSecret: "binding.endpoints-non-secret",
	credentialsAreRefs: "binding.credentials-are-refs",
	rotationPreservesIdentity: "binding.rotation-preserves-identity",
	expiryBehavesAsDeclared: "binding.expiry-behaves-as-declared",
} as const;

export type BindingCheck = (typeof BINDING_CHECKS)[keyof typeof BINDING_CHECKS];

export const BINDING_STEPS = ["produce", "rotate", "use-expired"] as const;

export type BindingStep = (typeof BINDING_STEPS)[number];

export const EXPIRED_BINDING_POLICIES = ["refuse", "renew"] as const;
export type ExpiredBindingPolicy = (typeof EXPIRED_BINDING_POLICIES)[number];

export const EXPIRED_BINDING_OBSERVATIONS = [
	"refused",
	"renewed",
	"accepted",
] as const;
export type ExpiredBindingObservation =
	(typeof EXPIRED_BINDING_OBSERVATIONS)[number];

export interface BindingProbeRequest {
	readonly caseId: string;
	readonly step: BindingStep;
	readonly resourceRef: string;
	readonly capabilityProfileRef: string;
	/** Injected instant. The suite never reads a clock. */
	readonly nowMs: number;
}

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface BindingProbeOutcome {
	readonly caseId: string;
	readonly binding: CapabilityBindingInput;
	readonly previousBinding?: CapabilityBindingInput;
	readonly expiredUse?: {
		readonly declared: ExpiredBindingPolicy;
		readonly observed: ExpiredBindingObservation;
	};
}

export type BindingExpectation =
	| { readonly kind: "binding-round-trips" }
	| { readonly kind: "endpoints-carry-no-credential" }
	| { readonly kind: "credentials-are-references" }
	| { readonly kind: "rotation-preserves-resource-identity" }
	| { readonly kind: "expired-binding-behaves-as-declared" };

export type BindingCase = AnonymousCase<
	BindingProbeRequest,
	BindingExpectation
>;

const RESOURCE_REF = "resource:conformance/claimable-1";
const CAPABILITY_PROFILE = "capability.relational-database/v1";
const NOW_MS = 1_700_000_000_000;

export const BINDING_CASES: readonly BindingCase[] = Object.freeze([
	{
		id: "binding/round-trips-through-the-parse-boundary",
		check: BINDING_CHECKS.roundTrip,
		title:
			"the produced binding survives a serialize/parse round trip unchanged",
		request: {
			caseId: "binding/round-trips-through-the-parse-boundary",
			step: "produce",
			resourceRef: RESOURCE_REF,
			capabilityProfileRef: CAPABILITY_PROFILE,
			nowMs: NOW_MS,
		},
		expect: { kind: "binding-round-trips" },
	},
	{
		id: "binding/endpoints-are-not-credentials",
		check: BINDING_CHECKS.endpointsNonSecret,
		title: "endpoint addresses are bare hostnames, never embedded credentials",
		request: {
			caseId: "binding/endpoints-are-not-credentials",
			step: "produce",
			resourceRef: RESOURCE_REF,
			capabilityProfileRef: CAPABILITY_PROFILE,
			nowMs: NOW_MS,
		},
		expect: { kind: "endpoints-carry-no-credential" },
	},
	{
		id: "binding/credentials-are-secret-references",
		check: BINDING_CHECKS.credentialsAreRefs,
		title:
			"credential and certificate material appear only as secret references",
		request: {
			caseId: "binding/credentials-are-secret-references",
			step: "produce",
			resourceRef: RESOURCE_REF,
			capabilityProfileRef: CAPABILITY_PROFILE,
			nowMs: NOW_MS,
		},
		expect: { kind: "credentials-are-references" },
	},
	{
		id: "binding/rotation-preserves-resource-identity",
		check: BINDING_CHECKS.rotationPreservesIdentity,
		title: "rotating the credential keeps the logical resource identity",
		request: {
			caseId: "binding/rotation-preserves-resource-identity",
			step: "rotate",
			resourceRef: RESOURCE_REF,
			capabilityProfileRef: CAPABILITY_PROFILE,
			nowMs: NOW_MS,
		},
		expect: { kind: "rotation-preserves-resource-identity" },
	},
	{
		id: "binding/expired-binding-behaves-as-declared",
		check: BINDING_CHECKS.expiryBehavesAsDeclared,
		title: "an expired binding does what the product said it would do",
		request: {
			caseId: "binding/expired-binding-behaves-as-declared",
			step: "use-expired",
			resourceRef: RESOURCE_REF,
			capabilityProfileRef: CAPABILITY_PROFILE,
			nowMs: NOW_MS,
		},
		expect: { kind: "expired-binding-behaves-as-declared" },
	},
]);

/**
 * Shapes that mean a credential travelled inside a field reserved for
 * non-secret address metadata.
 */
const CREDENTIAL_PATTERN = [
	/:\/\/[^/@]*:[^/@]*@/u,
	/\b(?:password|passwd|secret|token|api[-_]?key|access[-_]?key)\s*[=:]/iu,
	/^(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}$/u,
	/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
] as const;

function looksLikeCredential(value: string): boolean {
	return CREDENTIAL_PATTERN.some((pattern) => pattern.test(value));
}

export function parseBindingProbeOutcome(
	raw: JsonValue,
	caseId: string,
): BindingProbeOutcome {
	const record = requireRecord(raw, caseId, "binding outcome");
	const reportedCaseId = requireText(record.caseId, caseId, "caseId");
	if (reportedCaseId !== caseId) {
		throw new AnonymousConformanceError(
			caseId,
			`outcome reports caseId ${JSON.stringify(reportedCaseId)}`,
		);
	}

	const binding = requireBindingInput(record.binding, caseId, "binding");
	const previousBinding =
		record.previousBinding === undefined
			? undefined
			: requireBindingInput(record.previousBinding, caseId, "previousBinding");
	const expiredUse =
		record.expiredUse === undefined
			? undefined
			: parseExpiredUse(record.expiredUse, caseId);

	return {
		caseId,
		binding,
		...(previousBinding !== undefined ? { previousBinding } : undefined),
		...(expiredUse !== undefined ? { expiredUse } : undefined),
	};
}

/**
 * Structural gate only. Whether the binding is *legal* is decided by
 * `parseCapabilityBinding` inside the judges, because "the boundary rejected
 * it" is the finding, not a parse error in the harness.
 */
function requireBindingInput<T>(
	raw: T,
	caseId: string,
	field: string,
): CapabilityBindingInput {
	const record = requireRecord(raw, caseId, field);
	requireText(record.id, caseId, `${field}.id`);
	requireText(record.resourceRef, caseId, `${field}.resourceRef`);
	requireText(record.bindingProfileRef, caseId, `${field}.bindingProfileRef`);
	if (!Array.isArray(record.endpoints)) {
		throw new AnonymousConformanceError(
			caseId,
			`${field}.endpoints must be an array`,
		);
	}
	// SAFETY: binding probe records are restored to CapabilityBindingInput here.
	return record as never;
}

function parseExpiredUse<T>(
	raw: T,
	caseId: string,
): NonNullable<BindingProbeOutcome["expiredUse"]> {
	const record = requireRecord(raw, caseId, "expiredUse");
	const declared = optionalMember(
		record.declared,
		caseId,
		"expiredUse.declared",
		EXPIRED_BINDING_POLICIES,
	);
	const observed = optionalMember(
		record.observed,
		caseId,
		"expiredUse.observed",
		EXPIRED_BINDING_OBSERVATIONS,
	);
	if (declared === undefined || observed === undefined) {
		throw new AnonymousConformanceError(
			caseId,
			"expiredUse must state both the declared policy and the observed behavior",
		);
	}
	return { declared, observed };
}

function parseAtBoundary(
	input: CapabilityBindingInput,
): { readonly binding: CapabilityBinding } | { readonly rejected: string } {
	try {
		return { binding: parseCapabilityBinding(input, parseSecretRef) };
	} catch (error) {
		return {
			rejected: error instanceof Error ? error.message : String(error),
		};
	}
}

function judgeBindingCase(
	suiteCase: BindingCase,
	outcome: BindingProbeOutcome,
): CaseJudgement {
	switch (suiteCase.expect.kind) {
		case "binding-round-trips":
			return judgeRoundTrip(outcome);
		case "endpoints-carry-no-credential":
			return judgeEndpoints(outcome);
		case "credentials-are-references":
			return judgeCredentialRefs(outcome);
		case "rotation-preserves-resource-identity":
			return judgeRotation(outcome);
		case "expired-binding-behaves-as-declared":
			return judgeExpiredUse(outcome);
	}
}

function judgeRoundTrip(outcome: BindingProbeOutcome): CaseJudgement {
	const parsed = parseAtBoundary(outcome.binding);
	if ("rejected" in parsed) {
		return {
			outcome: "fail",
			detail: `the capability-binding boundary rejected the produced binding: ${parsed.rejected}`,
		};
	}
	const wire: unknown = JSON.parse(JSON.stringify(parsed.binding));
	// SAFETY: assertion to `re as CapabilityBindingInput);` is required at this boundary.
	const reparsed = parseAtBoundary(wire as CapabilityBindingInput);
	if ("rejected" in reparsed) {
		return {
			outcome: "fail",
			detail: `the binding did not survive its own wire form: ${reparsed.rejected}`,
		};
	}
	if (JSON.stringify(parsed.binding) !== JSON.stringify(reparsed.binding)) {
		return {
			outcome: "fail",
			detail: "the binding changed shape across a serialize/parse round trip",
		};
	}
	return {
		outcome: "pass",
		detail: `binding ${parsed.binding.id} round-trips through the parse boundary`,
	};
}

function judgeEndpoints(outcome: BindingProbeOutcome): CaseJudgement {
	const parsed = parseAtBoundary(outcome.binding);
	if ("rejected" in parsed) {
		return {
			outcome: "fail",
			detail: `endpoints were rejected by the binding boundary: ${parsed.rejected}`,
		};
	}
	if (parsed.binding.endpoints.length === 0) {
		return {
			outcome: "fail",
			detail: "the binding exposes no endpoint at all",
		};
	}
	for (const endpoint of parsed.binding.endpoints) {
		const address = endpoint.addressRef;
		const fields = [address.host, address.path ?? "", endpoint.role ?? ""];
		for (const field of fields) {
			if (field.length > 0 && looksLikeCredential(field)) {
				return {
					outcome: "fail",
					detail: `endpoint metadata for ${endpoint.protocol} carries credential-shaped material`,
				};
			}
		}
	}
	for (const [key, value] of Object.entries(
		parsed.binding.metadataRefs ?? {},
	)) {
		if (looksLikeCredential(value)) {
			return {
				outcome: "fail",
				detail: `metadata entry ${key} carries credential-shaped material`,
			};
		}
	}
	return {
		outcome: "pass",
		detail: `${parsed.binding.endpoints.length} endpoint(s) carry address metadata only`,
	};
}

function judgeCredentialRefs(outcome: BindingProbeOutcome): CaseJudgement {
	const raw = outcome.binding;
	if (raw.credentialRef === undefined) {
		return {
			outcome: "fail",
			detail:
				"the binding names no credential reference, so nothing proves credentials stay out of it",
		};
	}
	if (tryParseSecretRef(raw.credentialRef) === undefined) {
		return {
			outcome: "fail",
			detail:
				"credentialRef is not a registered secret locator; the material itself may be inline",
		};
	}
	if (
		raw.certificateRef !== undefined &&
		tryParseSecretRef(raw.certificateRef) === undefined
	) {
		return {
			outcome: "fail",
			detail: "certificateRef is not a registered secret locator",
		};
	}
	const parsed = parseAtBoundary(raw);
	if ("rejected" in parsed) {
		return {
			outcome: "fail",
			detail: `the binding boundary rejected the credential locators: ${parsed.rejected}`,
		};
	}
	return {
		outcome: "pass",
		detail:
			"credential and certificate material appear only as secret references",
	};
}

function judgeRotation(outcome: BindingProbeOutcome): CaseJudgement {
	if (outcome.previousBinding === undefined) {
		return {
			outcome: "fail",
			detail:
				"the rotation step reported no pre-rotation binding to compare against",
		};
	}
	const before = parseAtBoundary(outcome.previousBinding);
	const after = parseAtBoundary(outcome.binding);
	if ("rejected" in before) {
		return {
			outcome: "fail",
			detail: `the pre-rotation binding was rejected: ${before.rejected}`,
		};
	}
	if ("rejected" in after) {
		return {
			outcome: "fail",
			detail: `the rotated binding was rejected: ${after.rejected}`,
		};
	}
	if (before.binding.resourceRef !== after.binding.resourceRef) {
		return {
			outcome: "fail",
			detail: `rotation moved the resource from ${before.binding.resourceRef} to ${after.binding.resourceRef}; that is a migration, not a rotation`,
		};
	}
	if (
		before.binding.capabilityProfileRef !== after.binding.capabilityProfileRef
	) {
		return {
			outcome: "fail",
			detail: "rotation changed the capability profile the binding satisfies",
		};
	}
	if (before.binding.bindingProfileRef !== after.binding.bindingProfileRef) {
		return {
			outcome: "fail",
			detail: "rotation changed the binding profile the workload consumes",
		};
	}
	const hostsBefore = endpointHosts(before.binding);
	const hostsAfter = endpointHosts(after.binding);
	if (hostsBefore !== hostsAfter) {
		return {
			outcome: "fail",
			detail: `rotation changed the endpoint set from [${hostsBefore}] to [${hostsAfter}]`,
		};
	}
	if (before.binding.credentialRef === after.binding.credentialRef) {
		return {
			outcome: "fail",
			detail: "the credential reference is unchanged, so nothing was rotated",
		};
	}
	if (!after.binding.rotationSupported) {
		return {
			outcome: "fail",
			detail: "the rotated binding does not declare rotation support",
		};
	}
	return {
		outcome: "pass",
		detail: `credential rotated while ${after.binding.resourceRef} kept its identity and endpoints`,
	};
}

function endpointHosts(binding: CapabilityBinding): string {
	return binding.endpoints
		.map(
			(endpoint) =>
				`${endpoint.protocol}://${endpoint.addressRef.host}:${endpoint.addressRef.port ?? "-"}`,
		)
		.sort()
		.join(",");
}

function judgeExpiredUse(outcome: BindingProbeOutcome): CaseJudgement {
	const expired = outcome.expiredUse;
	if (expired === undefined) {
		return {
			outcome: "fail",
			detail: "the adapter never exercised an expired binding",
		};
	}
	if (outcome.binding.expiresAtMs === undefined) {
		return {
			outcome: "fail",
			detail:
				"the binding declares no expiry, so expired-binding behavior is undefined",
		};
	}
	if (expired.observed === "accepted") {
		return {
			outcome: "fail",
			detail: "an expired binding still authenticated against the resource",
		};
	}
	const required = expired.declared === "refuse" ? "refused" : "renewed";
	if (expired.observed !== required) {
		return {
			outcome: "fail",
			detail: `the product declared "${expired.declared}" on expiry but the binding was ${expired.observed}`,
		};
	}
	return {
		outcome: "pass",
		detail: `an expired binding was ${expired.observed}, matching the declared "${expired.declared}" policy`,
	};
}

export const BINDING_CONFORMANCE_SUITE: AnonymousSuiteDefinition<
	BindingProbeRequest,
	BindingExpectation,
	BindingProbeOutcome
> = Object.freeze({
	suiteId: BINDING_SUITE_ID,
	dimension: "binding",
	checks: Object.freeze(Object.values(BINDING_CHECKS)),
	cases: BINDING_CASES,
	parse: parseBindingProbeOutcome,
	judge: judgeBindingCase,
});
