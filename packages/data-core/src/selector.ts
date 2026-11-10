/**
 * Deterministic pattern selection (ADR-0177 decision 8).
 *
 * Choosing how to move data is a Matching-class decision: a pure function, no
 * clock, no model on the path, the same inputs always producing the same
 * digest. Candidates pass hard gates and survivors are ordered
 * lexicographically — never by a weighted score, because a score lets a
 * cheaper pattern buy its way past a weaker rollback (ADR-0151 §11).
 *
 * There is no silent downgrade. When nothing survives, the result is a
 * rejection that names a reason for every candidate, in the same
 * agent-correctable form as `deployment.PlanRejected`.
 */
import type { DatasetSchema } from "./canonical.js";
import type { PolicyVerdict } from "./custody.js";
import { DataCoreError } from "./errors.js";
import { digestOf, type JsonObject } from "./json.js";
import {
	type Authority,
	type ChangeKind,
	MIGRATION_PATTERNS,
	type MigrationPattern,
	type MigrationPatternId,
	PATTERN_CATALOG,
	patternCatalogDigest,
	ROLLBACK_POSTURES,
	type RollbackPosture,
	type WriteFreeze,
} from "./patterns.js";
import type { EngineDeclaration, SpiPortName } from "./spi.js";
import {
	blockingMappingFindings,
	composeTypeMapping,
	type MappingFinding,
} from "./type-mapping.js";

// public-contract: the schema id a migration decision is published under.
export const MIGRATION_DECISION_CONTRACT = "hobo.migration-decision/v1";

export const REALIZATIONS = ["native", "hub"] as const;
/** `native` is an engine's own fast path; `hub` is the canonical envelope. */
export type Realization = (typeof REALIZATIONS)[number];

export const CONFORMANCE_OUTCOMES = ["pass", "fail", "unknown"] as const;
export type ConformanceOutcome = (typeof CONFORMANCE_OUTCOMES)[number];

/** What a conformance run recorded for one engine. */
export interface ConformanceEvidence {
	readonly engine: string;
	readonly outcome: ConformanceOutcome;
	/** RFC 3339 instant the suite ran. */
	readonly checkedAt: string;
}

export interface SelectionConstraints {
	/** Longest the application may be refused writes, in milliseconds. */
	readonly maxWriteFreezeMs: number;
	/** Weakest rollback posture acceptable during the soak window. */
	readonly requiredRollback: RollbackPosture;
}

/**
 * Estimates the planner supplies per pattern. An absent estimate is never
 * treated as zero: an unestimated freeze fails its gate and an unestimated
 * cost ranks last.
 */
export interface SelectionEstimates {
	readonly flipMs?: number;
	readonly copyMs?: number;
	readonly custodyPoints?: Partial<Record<MigrationPatternId, number>>;
	readonly costMinorUnits?: Partial<Record<MigrationPatternId, number>>;
}

export interface SelectionRequest {
	readonly authority: Authority;
	readonly change: ChangeKind;
	readonly source?: EngineDeclaration;
	readonly target?: EngineDeclaration;
	/** Required whenever the two engines differ: the mapping is computed over it. */
	readonly schema?: DatasetSchema;
	readonly constraints: SelectionConstraints;
	readonly estimates?: SelectionEstimates;
	readonly verdict: PolicyVerdict;
	readonly waivers?: readonly string[];
	readonly evidence?: readonly ConformanceEvidence[];
	/** Injected instant, RFC 3339. */
	readonly now: string;
	/** How old conformance evidence may be before it is stale. */
	readonly evidenceMaxAgeMs: number;
}

export const SELECTION_REASON_CODES = [
	"PATTERN_ILLEGAL_FOR_CELL",
	"ENGINE_DECLARATION_MISSING",
	"PORT_MISSING",
	"MAPPING_UNVERIFIED",
	"MAPPING_BLOCKED",
	"EVIDENCE_MISSING",
	"EVIDENCE_FAILED",
	"EVIDENCE_STALE",
	"POLICY_DENIED",
	"FREEZE_UNESTIMATED",
	"FREEZE_EXCEEDS_BUDGET",
	"ROLLBACK_INSUFFICIENT",
] as const;
export type SelectionReasonCode = (typeof SELECTION_REASON_CODES)[number];

// domain-view: computed reason; wire form is SelectionReason in data-models/data_core.proto.
export interface SelectionReason {
	readonly code: SelectionReasonCode;
	readonly detail: string;
}

// domain-view: computed candidate; wire form is MigrationCandidate in data-models/data_core.proto.
export interface MigrationCandidate {
	readonly pattern: MigrationPatternId;
	readonly realization: Realization;
	/** The native migration profile, for a `native` realization. */
	readonly profile?: string;
	readonly eligible: boolean;
	readonly reasons: readonly SelectionReason[];
	readonly writeFreeze: WriteFreeze;
	readonly rollbackInSoak: RollbackPosture;
	readonly reverseTail: boolean;
}

// domain-view: computed decision; wire form is MigrationDecision in data-models/data_core.proto.
export interface MigrationDecision {
	readonly contract: typeof MIGRATION_DECISION_CONTRACT;
	readonly authority: Authority;
	readonly change: ChangeKind;
	/** Absent when every candidate was rejected. */
	readonly selected?: MigrationCandidate;
	readonly candidates: readonly MigrationCandidate[];
	readonly mappingFindings: readonly MappingFinding[];
	readonly catalogDigest: `sha256:${string}`;
	/** Digest of this decision and the inputs that produced it. */
	readonly digest: `sha256:${string}`;
}

function invalid(message: string, field: string): never {
	throw new DataCoreError("INVALID_SELECTION_REQUEST", message, {
		detail: { field },
	});
}

function hasPorts(
	declaration: EngineDeclaration | undefined,
	ports: readonly SpiPortName[],
): readonly SpiPortName[] {
	if (declaration === undefined) return ports;
	return ports.filter((port) => !declaration.ports.includes(port));
}

function nativeProfileFor(
	request: SelectionRequest,
	pattern: MigrationPatternId,
): string | undefined {
	const { source, target } = request;
	if (source === undefined || target === undefined) return undefined;
	if (source.engine !== target.engine) return undefined;
	const offered = source.nativeProfiles.find(
		(entry) => entry.pattern === pattern,
	);
	if (offered === undefined) return undefined;
	return target.nativeProfiles.some(
		(entry) => entry.profile === offered.profile,
	)
		? offered.profile
		: undefined;
}

function evidenceReasons(
	request: SelectionRequest,
	now: number,
	engines: readonly string[],
): SelectionReason[] {
	const reasons: SelectionReason[] = [];
	for (const engine of engines) {
		const evidence = (request.evidence ?? []).find(
			(entry) => entry.engine === engine,
		);
		if (evidence === undefined) {
			reasons.push({
				code: "EVIDENCE_MISSING",
				detail: `no conformance evidence for ${engine}`,
			});
			continue;
		}
		if (evidence.outcome !== "pass") {
			reasons.push({
				code: "EVIDENCE_FAILED",
				detail: `conformance for ${engine} is ${evidence.outcome}`,
			});
			continue;
		}
		const checkedAt = Date.parse(evidence.checkedAt);
		if (Number.isNaN(checkedAt) || now - checkedAt > request.evidenceMaxAgeMs) {
			reasons.push({
				code: "EVIDENCE_STALE",
				detail: `conformance for ${engine} was last checked ${evidence.checkedAt}`,
			});
		}
	}
	return reasons;
}

function freezeMs(
	pattern: MigrationPattern,
	estimates: SelectionEstimates | undefined,
): number | undefined {
	if (pattern.writeFreeze === "none") return 0;
	return pattern.writeFreeze === "bounded"
		? estimates?.flipMs
		: estimates?.copyMs;
}

function rank(posture: RollbackPosture): number {
	return ROLLBACK_POSTURES.indexOf(posture);
}

const FREEZE_RANK: Readonly<Record<WriteFreeze, number>> = Object.freeze({
	none: 0,
	bounded: 1,
	window: 2,
});

function evaluateCandidate(
	request: SelectionRequest,
	pattern: MigrationPattern,
	realization: Realization,
	mapping: readonly MappingFinding[] | undefined,
	now: number,
): MigrationCandidate {
	const reasons: SelectionReason[] = [];
	const legal =
		pattern.authorities.includes(request.authority) &&
		pattern.changes.includes(request.change);
	if (!legal) {
		// Nothing else about an undefined pattern is worth reporting: its
		// other gates would only add noise to the rejection record.
		return Object.freeze({
			pattern: pattern.id,
			realization,
			eligible: false,
			reasons: Object.freeze([
				Object.freeze({
					code: "PATTERN_ILLEGAL_FOR_CELL" as const,
					detail: `${pattern.id} is not defined for ${request.authority} data changing ${request.change}`,
				}),
			]),
			writeFreeze: pattern.writeFreeze,
			rollbackInSoak: pattern.rollbackInSoak,
			reverseTail: false,
		});
	}
	const profile =
		realization === "native"
			? nativeProfileFor(request, pattern.id)
			: undefined;
	const needsSource = pattern.sourcePorts.length > 0;
	const needsTarget = pattern.targetPorts.length > 0;
	const engines: string[] = [];
	if (needsSource) {
		if (request.source === undefined) {
			reasons.push({
				code: "ENGINE_DECLARATION_MISSING",
				detail: `${pattern.id} needs a source engine declaration`,
			});
		} else {
			engines.push(request.source.engine);
		}
	}
	if (needsTarget) {
		if (request.target === undefined) {
			reasons.push({
				code: "ENGINE_DECLARATION_MISSING",
				detail: `${pattern.id} needs a target engine declaration`,
			});
		} else if (!engines.includes(request.target.engine)) {
			engines.push(request.target.engine);
		}
	}
	if (realization === "hub") {
		const missingSource =
			needsSource && request.source !== undefined
				? hasPorts(request.source, pattern.sourcePorts)
				: [];
		const missingTarget =
			needsTarget && request.target !== undefined
				? hasPorts(request.target, pattern.targetPorts)
				: [];
		if (missingSource.length > 0) {
			reasons.push({
				code: "PORT_MISSING",
				detail: `source ${request.source?.engine ?? "engine"} lacks ${missingSource.join(", ")}`,
			});
		}
		if (missingTarget.length > 0) {
			reasons.push({
				code: "PORT_MISSING",
				detail: `target ${request.target?.engine ?? "engine"} lacks ${missingTarget.join(", ")}`,
			});
		}
		const crossEngine =
			request.source !== undefined &&
			request.target !== undefined &&
			request.source.engine !== request.target.engine;
		if (crossEngine && mapping === undefined) {
			reasons.push({
				code: "MAPPING_UNVERIFIED",
				detail:
					"a cross-engine move needs the dataset schema to compute the type mapping",
			});
		}
		for (const finding of blockingMappingFindings(
			mapping ?? [],
			request.waivers ?? [],
		)) {
			reasons.push({ code: "MAPPING_BLOCKED", detail: finding.detail });
		}
	}
	reasons.push(...evidenceReasons(request, now, engines));
	if (!request.verdict.ok) {
		reasons.push({
			code: "POLICY_DENIED",
			detail: request.verdict.findings
				.map((finding) => finding.code)
				.join(", "),
		});
	}
	const estimatedFreeze = freezeMs(pattern, request.estimates);
	if (estimatedFreeze === undefined) {
		reasons.push({
			code: "FREEZE_UNESTIMATED",
			detail: `${pattern.id} refuses writes (${pattern.writeFreeze}) and no estimate was supplied`,
		});
	} else if (estimatedFreeze > request.constraints.maxWriteFreezeMs) {
		reasons.push({
			code: "FREEZE_EXCEEDS_BUDGET",
			detail: `${pattern.id} needs about ${estimatedFreeze} ms of refused writes; the budget is ${request.constraints.maxWriteFreezeMs} ms`,
		});
	}
	const reverseTail =
		realization === "hub" &&
		(pattern.reverseTailPorts.source.length > 0 ||
			pattern.reverseTailPorts.target.length > 0) &&
		hasPorts(request.source, pattern.reverseTailPorts.source).length === 0 &&
		hasPorts(request.target, pattern.reverseTailPorts.target).length === 0;
	const rollbackInSoak = reverseTail
		? pattern.rollbackInSoakWithReverseTail
		: pattern.rollbackInSoak;
	if (rank(rollbackInSoak) < rank(request.constraints.requiredRollback)) {
		reasons.push({
			code: "ROLLBACK_INSUFFICIENT",
			detail: `${pattern.id} offers ${rollbackInSoak} rollback in soak; ${request.constraints.requiredRollback} is required`,
		});
	}
	return Object.freeze({
		pattern: pattern.id,
		realization,
		...(profile === undefined ? undefined : { profile }),
		eligible: reasons.length === 0,
		reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
		writeFreeze: pattern.writeFreeze,
		rollbackInSoak,
		reverseTail,
	});
}

function orderKey(
	candidate: MigrationCandidate,
	estimates: SelectionEstimates | undefined,
): readonly (number | string)[] {
	const custody = estimates?.custodyPoints?.[candidate.pattern];
	const cost = estimates?.costMinorUnits?.[candidate.pattern];
	return [
		-rank(candidate.rollbackInSoak),
		FREEZE_RANK[candidate.writeFreeze],
		candidate.realization === "native" ? 0 : 1,
		custody ?? Number.MAX_SAFE_INTEGER,
		cost ?? Number.MAX_SAFE_INTEGER,
		candidate.pattern,
	];
}

function compareKeys(
	left: readonly (number | string)[],
	right: readonly (number | string)[],
): number {
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		if (a < b) return -1;
		if (a > b) return 1;
	}
	return 0;
}

function candidateToJson(candidate: MigrationCandidate): JsonObject {
	return {
		pattern: candidate.pattern,
		realization: candidate.realization,
		...(candidate.profile === undefined
			? undefined
			: { profile: candidate.profile }),
		eligible: candidate.eligible,
		reasons: candidate.reasons.map((reason) => ({
			code: reason.code,
			detail: reason.detail,
		})),
		writeFreeze: candidate.writeFreeze,
		rollbackInSoak: candidate.rollbackInSoak,
		reverseTail: candidate.reverseTail,
	};
}

/**
 * Select a migration pattern. Every pattern in the catalog appears among the
 * candidates — including the ones that are illegal for this authority and
 * change — so a rejection is a complete record rather than an empty list.
 */
export function selectMigrationPattern(
	request: SelectionRequest,
): MigrationDecision {
	const now = Date.parse(request.now);
	if (Number.isNaN(now)) invalid("now must be an RFC 3339 instant", "now");
	if (!(request.constraints.maxWriteFreezeMs >= 0)) {
		invalid(
			"maxWriteFreezeMs must be zero or more",
			"constraints.maxWriteFreezeMs",
		);
	}
	if (!(request.evidenceMaxAgeMs >= 0)) {
		invalid("evidenceMaxAgeMs must be zero or more", "evidenceMaxAgeMs");
	}
	const { source, target, schema } = request;
	const sameEngine =
		source !== undefined &&
		target !== undefined &&
		source.engine === target.engine;
	const mapping =
		source !== undefined && target !== undefined && schema !== undefined
			? composeTypeMapping(schema, source.typeMapping, target.typeMapping)
			: sameEngine
				? []
				: undefined;
	const candidates: MigrationCandidate[] = [];
	for (const id of MIGRATION_PATTERNS) {
		const pattern = PATTERN_CATALOG.find((entry) => entry.id === id);
		if (pattern === undefined) continue;
		if (nativeProfileFor(request, id) !== undefined) {
			candidates.push(
				evaluateCandidate(request, pattern, "native", mapping, now),
			);
		}
		candidates.push(evaluateCandidate(request, pattern, "hub", mapping, now));
	}
	const survivors = candidates
		.filter((candidate) => candidate.eligible)
		.sort((left, right) =>
			compareKeys(
				orderKey(left, request.estimates),
				orderKey(right, request.estimates),
			),
		);
	const selected = survivors[0];
	const catalogDigest = patternCatalogDigest();
	const body = {
		contract: MIGRATION_DECISION_CONTRACT,
		authority: request.authority,
		change: request.change,
		catalogDigest,
		verdictDigest: request.verdict.custodyDigest,
		verdictOk: request.verdict.ok,
		constraints: {
			maxWriteFreezeMs: request.constraints.maxWriteFreezeMs,
			requiredRollback: request.constraints.requiredRollback,
		},
		source: source?.engine ?? null,
		target: target?.engine ?? null,
		schema: schema?.name ?? null,
		waivers: [...(request.waivers ?? [])].sort(),
		candidates: candidates.map((candidate) => candidateToJson(candidate)),
		selected: selected === undefined ? null : candidateToJson(selected),
	};
	return Object.freeze({
		contract: MIGRATION_DECISION_CONTRACT,
		authority: request.authority,
		change: request.change,
		...(selected === undefined ? undefined : { selected }),
		candidates: Object.freeze(candidates),
		mappingFindings: Object.freeze([...(mapping ?? [])]),
		catalogDigest,
		digest: digestOf(body),
	});
}

export function migrationDecisionToJson(
	decision: MigrationDecision,
): JsonObject {
	return {
		contract: decision.contract,
		authority: decision.authority,
		change: decision.change,
		selected:
			decision.selected === undefined
				? null
				: candidateToJson(decision.selected),
		candidates: decision.candidates.map((candidate) =>
			candidateToJson(candidate),
		),
		mappingFindings: decision.mappingFindings.map((finding) => ({
			code: finding.code,
			field: finding.field,
			canonical: finding.canonical,
			fidelity: finding.fidelity,
			waiverKey: finding.waiverKey,
			detail: finding.detail,
		})),
		catalogDigest: decision.catalogDigest,
		digest: decision.digest,
	};
}
