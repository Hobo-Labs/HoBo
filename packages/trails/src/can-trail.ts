/**
 * can-trail Gatekeeper dimension — compatible with can-deploy / can-migrate shapes.
 * Offline-capable dry-run evidence.
 */
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
	/**
	 * Policy allows Trail run (default true). `false` denies the trail whatever
	 * else is supplied.
	 */
	policyAllows?: boolean;
	/** Dual oracle fixtures ready for continuous steps. */
	dualOracleReady?: boolean;
	/** Junction / overlay healthy when trail requires cross-cloud. */
	junctionHealthy?: boolean;
	/** Conflicting active trail run for same tenant+target. */
	conflictingTrail?: boolean;
	/**
	 * Residency obligation conflict. `true` denies the trail whatever else is
	 * supplied.
	 */
	residencyConflict?: boolean;
	/**
	 * A policy verdict computed over the migration's custody path — every
	 * place the data rests or passes (ADR-0177 decision 9).
	 *
	 * It is one more signal, not a replacement for the two booleans: the gate
	 * is a conjunction, so the trail is denied when `policyAllows` is `false`,
	 * or `residencyConflict` is `true`, or the verdict is negative or carries a
	 * finding. A passing verdict cannot lift a denial stated beside it. A
	 * verdict that is not the record `#CanTrailPolicyVerdictRecord` pins is a
	 * `policy-denied` reason, never an exception and never a pass.
	 *
	 * A verdict judges the path it was given. When a step names its migration
	 * pattern (`data.pattern`), every custody role that pattern creates must be
	 * among the verdict's `roles`, or the trail is denied: a relay or a
	 * retained change log the path never named was never judged.
	 */
	policyVerdict?: CanTrailPolicyVerdict;
}>;

/**
 * Structural mirror of the `@hobo/data-core` policy verdict, declared here so
 * the sealed Trails surface never re-exports a foreign package's types.
 */
export type CanTrailPolicyVerdict = Readonly<{
	ok: boolean;
	findings: readonly Readonly<{
		code: string;
		point: string;
		detail: string;
	}>[];
	custodyDigest: string;
	/**
	 * The custody roles the path behind the verdict named. A verdict without
	 * the member names none, so it covers no pattern.
	 */
	roles?: readonly string[];
}>;

/** Finding codes that are a residency conflict rather than a general denial. */
const RESIDENCY_FINDING_CODES: readonly string[] = Object.freeze([
	"CUSTODY_RESIDENCY_CONFLICT",
	"CUSTODY_REGION_UNMAPPED",
]);

/** `custodyDigest` as `data-models/migration.cue` constrains it. */
const CUSTODY_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** What a supplied verdict denies, as reason messages under each code. */
type VerdictDenials = Readonly<{
	policy: readonly string[];
	residency: readonly string[];
	/** The custody roles the verdict's path named. */
	roles: readonly string[];
}>;

const NO_DENIALS: VerdictDenials = Object.freeze({
	policy: Object.freeze([]),
	residency: Object.freeze([]),
	roles: Object.freeze([]),
});

/**
 * The defect is named by field, never by value: a verdict that is not what it
 * claims to be may be carrying anything.
 */
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

/**
 * Read a supplied verdict as the record `#CanTrailPolicyVerdictRecord` pins,
 * and return what it denies.
 *
 * The parameter is JSON rather than `CanTrailPolicyVerdict` on purpose. The
 * verdict is evidence handed across a package boundary, and a gate that trusts
 * the static type of its evidence throws on the first value that is not what
 * the type says — which is what this did, with a `TypeError`, for a verdict
 * with no `findings` list. Anything short of the record denies the trail.
 *
 * A well-formed verdict denies when it says so *or* when it carries a finding:
 * `ok: true` beside a finding is read as the finding, the stricter of the two.
 */
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
	// Absent is not malformed — a verdict may predate the member — but it
	// names no role, and so covers no pattern.
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
		// Computed evidence: each finding names the custody point at fault.
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

/**
 * What the patterns a trail names create that the verdict's path left out.
 * The realization and the reverse tail are not known at a dry run, so each
 * pattern is read at its most demanding: every role it can create.
 */
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

/**
 * Dry-run can-trail. Pure continuous identity trails report bindleConfigRequired:false.
 */
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

	// Validate recipes exist.
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
	// Pure identity continuous: never require Bindle config.
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

	// The policy gate is a conjunction: every supplied signal has to allow the
	// trail. A verdict used to supersede the two booleans, so a passing verdict
	// erased an explicit `policyAllows: false` or `residencyConflict: true`.
	const verdictSupplied = input.policyVerdict !== undefined;
	const fromVerdict =
		input.policyVerdict !== undefined
			? verdictDenials(input.policyVerdict)
			: NO_DENIALS;
	const policyDenials = [
		...fromVerdict.policy,
		// A verdict that passes over a path with a copy missing has not judged
		// that copy. Checked only against a supplied verdict: with none there
		// is no path to be incomplete.
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
	// One reason per code, every cause in its message. The position of
	// `residency-conflict` is the one each input style already had — first when
	// a verdict is supplied, last when only the booleans are — because the
	// summary names the first blocking code and callers have read it that way.
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
		// Informational evidence — not a failure.
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
