/**
 * can-trail Gatekeeper dimension — compatible with can-deploy / can-migrate shapes.
 * Offline-capable dry-run evidence.
 */
import type { TrailDefinition } from "./definition.js";
import { orderTrailSteps } from "./definition.js";
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
	/** Policy allows Trail run (default true). */
	policyAllows?: boolean;
	/** Dual oracle fixtures ready for continuous steps. */
	dualOracleReady?: boolean;
	/** Junction / overlay healthy when trail requires cross-cloud. */
	junctionHealthy?: boolean;
	/** Conflicting active trail run for same tenant+target. */
	conflictingTrail?: boolean;
	/** Residency obligation conflict. */
	residencyConflict?: boolean;
	/**
	 * A policy verdict computed over the migration's custody path — every
	 * place the data rests or passes (ADR-0177 decision 9). When present it
	 * supersedes `policyAllows` and `residencyConflict`: the gate then judges
	 * evidence instead of trusting a caller-supplied boolean.
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
}>;

/** Finding codes that are a residency conflict rather than a general denial. */
const RESIDENCY_FINDING_CODES: readonly string[] = Object.freeze([
	"CUSTODY_RESIDENCY_CONFLICT",
	"CUSTODY_REGION_UNMAPPED",
]);

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

	const verdict = input.policyVerdict;
	if (verdict !== undefined) {
		// Computed evidence: each finding names the custody point at fault.
		const residency = verdict.findings.filter((finding) =>
			RESIDENCY_FINDING_CODES.includes(finding.code),
		);
		const other = verdict.findings.filter(
			(finding) => !RESIDENCY_FINDING_CODES.includes(finding.code),
		);
		if (residency.length > 0) {
			reasons.push({
				code: "residency-conflict",
				message: residency.map((finding) => finding.detail).join("; "),
			});
		}
		if (other.length > 0 || (!verdict.ok && residency.length === 0)) {
			reasons.push({
				code: "policy-denied",
				message:
					other.length > 0
						? other.map((finding) => finding.detail).join("; ")
						: "policy verdict over the custody path is negative",
			});
		}
	} else if (input.policyAllows === false) {
		reasons.push({
			code: "policy-denied",
			message: "policy pack denies this trail",
		});
	}
	if (input.conflictingTrail === true) {
		reasons.push({
			code: "conflicting-trail",
			message: "another trail is active for this tenant/target",
		});
	}
	if (verdict === undefined && input.residencyConflict === true) {
		reasons.push({
			code: "residency-conflict",
			message: "residency obligation conflicts with trail targets",
		});
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
