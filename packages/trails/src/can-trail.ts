import { requiredCustodyRoles } from "@hobo/data-core";
import type { TrailDefinition } from "./definition.js";
import { orderTrailSteps } from "./definition.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import { composeTrailWithRecipes, getPlatformRecipe } from "./recipes.js";

// public-contract: can-trail dry-run schema version.
export const CAN_TRAIL_SCHEMA_VERSION = "hobo.can-trail/v1" as const;

export type CanTrailReason = Readonly<{
	code:
		| "definition-invalid"
		| "recipe-missing"
		| "step-cycle"
		| "policy-denied"
		| "junction-unhealthy"
		| "conflicting-trail"
		| "dual-oracle-not-ready"
		| "residency-conflict"
		| "identity-hands-off-ok";
	message: string;
}>;

export type CanTrailResult = Readonly<{
	schemaVersion: typeof CAN_TRAIL_SCHEMA_VERSION;
	ok: boolean;
	dimension: "can-trail";
	reasons: readonly CanTrailReason[];
	summary: string;
	evidence: Readonly<{
		trailId: string;
		trailVersion: string;
		contentHash: string;
		stepCount: number;
		orderedStepIds: readonly string[];
		identityContinuous: boolean;
		bindleConfigRequired: false | true;
		continuousDefault: boolean;
		dryRun: true;
		rollbackPosture: "compensate-to-source";
		junctionRequired: boolean;
	}>;
}>;

export type CanTrailInput = Readonly<{
	trail: TrailDefinition;
	policyAllows?: boolean;
	dualOracleReady?: boolean;
	junctionHealthy?: boolean;
	conflictingTrail?: boolean;
	residencyConflict?: boolean;
	policyVerdict?: CanTrailPolicyVerdict;
}>;

export type CanTrailPolicyVerdict = Readonly<{
	ok: boolean;
	findings: readonly Readonly<{
		code: string;
		point: string;
		detail: string;
	}>[];
	custodyDigest: string;
	roles?: readonly string[];
}>;

const RESIDENCY_FINDING_CODES: readonly string[] = Object.freeze([
	"CUSTODY_RESIDENCY_CONFLICT",
	"CUSTODY_REGION_UNMAPPED",
]);

const CUSTODY_DIGEST = /^sha256:[0-9a-f]{64}$/u;

type VerdictDenials = Readonly<{
	policy: readonly string[];
	residency: readonly string[];
	roles: readonly string[];
}>;

const NO_DENIALS: VerdictDenials = Object.freeze({
	policy: Object.freeze([]),
	residency: Object.freeze([]),
	roles: Object.freeze([]),
});

function malformedVerdict(defect: string): VerdictDenials {
	return {
		policy: [`policy verdict is malformed: ${defect}`],
		residency: [],
		roles: [],
	};
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
	return Array.isArray(value);
}

function isNonEmptyString(value: JsonValue): value is string {
	return isJsonString(value) && value.length > 0;
}

function verdictDenials(verdict: JsonValue): VerdictDenials {
	if (!isJsonObject(verdict)) {
		return malformedVerdict("it must be a record");
	}
	const { ok, findings, custodyDigest, roles } = verdict;
	if (ok !== true && ok !== false) {
		return malformedVerdict("ok must be a boolean");
	}
	if (!isJsonArray(findings)) {
		return malformedVerdict("findings must be a list");
	}
	if (!isJsonString(custodyDigest) || !CUSTODY_DIGEST.test(custodyDigest)) {
		return malformedVerdict(
			"custodyDigest must be the sha256 digest of the custody path",
		);
	}
	const named = roles === undefined ? [] : roles;
	if (!isJsonArray(named) || !named.every(isNonEmptyString)) {
		return malformedVerdict("roles must be a list of custody role names");
	}
	const policy: string[] = [];
	const residency: string[] = [];
	for (const [index, finding] of findings.entries()) {
		if (!isJsonObject(finding)) {
			return malformedVerdict(`finding ${index} must be a record`);
		}
		const { code, point, detail } = finding;
		if (
			!isNonEmptyString(code) ||
			!isNonEmptyString(point) ||
			!isJsonString(detail)
		) {
			return malformedVerdict(
				`finding ${index} must carry a code, a custody point, and a detail`,
			);
		}
		if (RESIDENCY_FINDING_CODES.includes(code)) {
			residency.push(detail);
		} else {
			policy.push(detail);
		}
	}
	if (!ok && findings.length === 0) {
		policy.push("policy verdict over the custody path is negative");
	}
	return { policy, residency, roles: named };
}

function uncoveredByVerdict(
	trail: TrailDefinition,
	roles: readonly string[],
): readonly string[] {
	const patterns = [
		...new Set(
			trail.steps.flatMap((step) =>
				step.data?.pattern === undefined ? [] : [step.data.pattern],
			),
		),
	];
	return patterns.flatMap((pattern) => {
		const missing = requiredCustodyRoles({ pattern }).filter(
			(role) => !roles.includes(role),
		);
		return missing.length === 0
			? []
			: [
					`the custody path does not cover ${pattern}: no custody point for ${missing.join(", ")}`,
				];
	});
}

export function evaluateCanTrail(input: CanTrailInput): CanTrailResult {
	const reasons: CanTrailReason[] = [];
	let composed: TrailDefinition;
	try {
		composed = composeTrailWithRecipes(input.trail);
	} catch (err) {
		reasons.push({
			code: "definition-invalid",
			message: err instanceof Error ? err.message : String(err),
		});
		return blocked(input.trail, reasons, [], false, false);
	}

	for (const id of composed.recipeList ?? []) {
		if (!getPlatformRecipe(id)) {
			reasons.push({
				code: "recipe-missing",
				message: `unknown recipe ${id}`,
			});
		}
	}

	let ordered: readonly { id: string }[] = [];
	try {
		ordered = orderTrailSteps(composed.steps);
	} catch {
		reasons.push({
			code: "step-cycle",
			message: "trail steps contain a dependency cycle",
		});
	}

	const identityContinuous = composed.steps.some(
		(s) => s.kind === "identity-continuous",
	);
	const junctionRequired = composed.steps.some(
		(s) => s.junction?.required === true || s.kind === "junction-rebind",
	);
	const progressive = composed.steps.some((s) => s.progressive === true);
	const bindleConfigRequired = identityContinuous
		? composed.steps.every(
				(s) =>
					s.kind === "identity-continuous" ||
					s.kind === "validation" ||
					s.kind === "cutover",
			)
			? false
			: composed.steps.some(
					(s) =>
						s.kind === "schema" ||
						s.kind === "data-transform" ||
						s.kind === "continuous-dual-data" ||
						s.kind === "custom",
				)
		: composed.steps.some(
				(s) =>
					s.kind === "schema" ||
					s.kind === "data-transform" ||
					s.kind === "continuous-dual-data" ||
					s.kind === "custom",
			);

	const verdictSupplied = input.policyVerdict !== undefined;
	const fromVerdict =
		input.policyVerdict !== undefined
			? verdictDenials(input.policyVerdict)
			: NO_DENIALS;
	const policyDenials = [
		...fromVerdict.policy,
		...(verdictSupplied ? uncoveredByVerdict(composed, fromVerdict.roles) : []),
	];
	if (input.policyAllows === false) {
		policyDenials.unshift("policy pack denies this trail");
	}
	const residencyConflicts = [...fromVerdict.residency];
	if (input.residencyConflict === true) {
		residencyConflicts.unshift(
			"residency obligation conflicts with trail targets",
		);
	}
	const residencyReason: CanTrailReason = {
		code: "residency-conflict",
		message: residencyConflicts.join("; "),
	};
	if (verdictSupplied && residencyConflicts.length > 0) {
		reasons.push(residencyReason);
	}
	if (policyDenials.length > 0) {
		reasons.push({
			code: "policy-denied",
			message: policyDenials.join("; "),
		});
	}
	if (input.conflictingTrail === true) {
		reasons.push({
			code: "conflicting-trail",
			message: "another trail is active for this tenant/target",
		});
	}
	if (!verdictSupplied && residencyConflicts.length > 0) {
		reasons.push(residencyReason);
	}
	if (
		(identityContinuous ||
			composed.steps.some((s) => s.kind === "continuous-dual-data")) &&
		input.dualOracleReady === false
	) {
		reasons.push({
			code: "dual-oracle-not-ready",
			message: "dual consistency oracle / fixtures not ready",
		});
	}
	if (junctionRequired && input.junctionHealthy === false) {
		reasons.push({
			code: "junction-unhealthy",
			message: "required junction/overlay is unhealthy",
		});
	}
	if (identityContinuous && !bindleConfigRequired) {
		reasons.push({
			code: "identity-hands-off-ok",
			message: "continuous identity trail requires zero Bindle/Trail authoring",
		});
	}

	const blocking = reasons.filter((r) => r.code !== "identity-hands-off-ok");
	const ok = blocking.length === 0;
	return Object.freeze({
		schemaVersion: CAN_TRAIL_SCHEMA_VERSION,
		ok,
		dimension: "can-trail" as const,
		reasons: Object.freeze(reasons),
		summary: ok
			? "can-trail:ok progressive continuous ready"
			: `can-trail:blocked (${blocking[0]?.code})`,
		evidence: Object.freeze({
			trailId: composed.id,
			trailVersion: composed.version,
			contentHash: composed.contentHash,
			stepCount: ordered.length,
			orderedStepIds: Object.freeze(ordered.map((s) => s.id)),
			identityContinuous,
			bindleConfigRequired,
			continuousDefault: progressive || identityContinuous,
			dryRun: true as const,
			rollbackPosture: "compensate-to-source" as const,
			junctionRequired,
		}),
	});
}

function blocked(
	trail: TrailDefinition,
	reasons: CanTrailReason[],
	ordered: readonly { id: string }[],
	identityContinuous: boolean,
	junctionRequired: boolean,
): CanTrailResult {
	return Object.freeze({
		schemaVersion: CAN_TRAIL_SCHEMA_VERSION,
		ok: false,
		dimension: "can-trail" as const,
		reasons: Object.freeze(reasons),
		summary: `can-trail:blocked (${reasons[0]?.code})`,
		evidence: Object.freeze({
			trailId: trail.id,
			trailVersion: trail.version,
			contentHash: trail.contentHash,
			stepCount: ordered.length,
			orderedStepIds: Object.freeze(ordered.map((s) => s.id)),
			identityContinuous,
			bindleConfigRequired: true as const,
			continuousDefault: false,
			dryRun: true as const,
			rollbackPosture: "compensate-to-source" as const,
			junctionRequired,
		}),
	});
}
