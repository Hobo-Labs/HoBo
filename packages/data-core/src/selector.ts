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
import { type DatasetSchema, instantMicros } from "./canonical.js";
import { type PolicyVerdict, uncoveredCustodyRoles } from "./custody.js";
import { DataCoreError } from "./errors.js";
import { MIGRATION_REALIZATIONS, type MigrationRealization } from "./facts.js";
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
import {
	type EngineDeclaration,
	type SpiPortName,
	sharedNativeProfile,
} from "./spi.js";
import {
	blockingMappingFindings,
	composeTypeMapping,
	type MappingFinding,
} from "./type-mapping.js";

// public-contract: the schema id a migration decision is published under.
export const MIGRATION_DECISION_CONTRACT = "hobo.migration-decision/v1";

export const REALIZATIONS = MIGRATION_REALIZATIONS;
/** `native` is an engine's own fast path; `hub` is the canonical envelope. */
export type Realization = MigrationRealization;

export const CONFORMANCE_OUTCOMES = ["pass", "fail", "unknown"] as const;
export type ConformanceOutcome = (typeof CONFORMANCE_OUTCOMES)[number];

/**
 * What a conformance run recorded for one engine.
 *
 * An engine may have several entries. The one that counts is the most recent;
 * when several share that instant, the worst of them. An entry whose
 * `checkedAt` is unreadable or lies after `now` fails the engine outright —
 * it could otherwise pose as the most recent run for ever.
 */
export interface ConformanceEvidence {
	readonly engine: string;
	readonly outcome: ConformanceOutcome;
	/** RFC 3339 instant, with an explicit offset, at which the suite ran. */
	readonly checkedAt: string;
}

export interface SelectionConstraints {
	/** Longest the application may be refused writes: finite milliseconds, zero or more. */
	readonly maxWriteFreezeMs: number;
	/** Weakest rollback posture acceptable during the soak window. */
	readonly requiredRollback: RollbackPosture;
}

/**
 * Estimates the planner supplies per pattern. An absent estimate is never
 * treated as zero: an unestimated freeze fails its gate and an unestimated
 * cost ranks last. An estimate that is not a finite number of zero or more —
 * `NaN`, an infinity, a negative — is not an estimate, and is read as absent.
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
	/** Injected instant, RFC 3339 with an explicit offset. */
	readonly now: string;
	/** How old conformance evidence may be before it is stale: finite milliseconds, zero or more. */
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
	"EVIDENCE_POSTDATED",
	"POLICY_DENIED",
	"CUSTODY_INCOMPLETE",
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
	return sharedNativeProfile(request.source, request.target, pattern);
}

/**
 * Ports a `native` realization does not use: the engine moves the records
 * itself, so the scan, the capture log and the apply path are not asked for.
 * Everything else a pattern needs — verification, the fence, retirement — it
 * still needs, whoever carries the records.
 */
export const NATIVE_TRANSPORT_PORTS: {
	readonly source: readonly SpiPortName[];
	readonly target: readonly SpiPortName[];
} = Object.freeze({
	source: Object.freeze(["snapshot", "capture"] as const),
	target: Object.freeze(["apply"] as const),
});

/** How bad an outcome is. Anything that is not a known better outcome is the worst. */
function severity(outcome: ConformanceOutcome): number {
	if (outcome === "pass") return 0;
	return outcome === "unknown" ? 1 : 2;
}

/**
 * The evidence gate for each engine involved.
 *
 * Every entry for the engine is read, never the first one found: `[pass,
 * fail]` and `[fail, pass]` are the same evidence. The entry that counts is
 * the most recent, and the worst of those that share its instant. An entry
 * the gate cannot place in time — an unreadable `checkedAt`, or one after
 * `now` — fails the engine, because it cannot be shown to be older than a
 * passing run and so cannot be outvoted by one.
 */
function evidenceReasons(
	request: SelectionRequest,
	now: bigint,
	engines: readonly string[],
): SelectionReason[] {
	const reasons: SelectionReason[] = [];
	// In microseconds, as instants are. The request was refused unless the
	// limit is finite and zero or more.
	const maxAgeMicros = request.evidenceMaxAgeMs * 1000;
	for (const engine of engines) {
		const entries = (request.evidence ?? []).filter(
			(entry) => entry.engine === engine,
		);
		if (entries.length === 0) {
			reasons.push({
				code: "EVIDENCE_MISSING",
				detail: `no conformance evidence for ${engine}`,
			});
			continue;
		}
		let counted: ConformanceEvidence | undefined;
		let countedAt = 0n;
		let unplaced = false;
		for (const entry of entries) {
			const checkedAt = instantMicros(entry.checkedAt);
			if (checkedAt === undefined) {
				unplaced = true;
				reasons.push({
					code: "EVIDENCE_STALE",
					detail: `conformance for ${engine} has no readable checkedAt (${entry.checkedAt}); an RFC 3339 instant with an explicit offset is required`,
				});
				continue;
			}
			if (checkedAt > now) {
				unplaced = true;
				reasons.push({
					code: "EVIDENCE_POSTDATED",
					detail: `conformance for ${engine} is dated ${entry.checkedAt}, after ${request.now}`,
				});
				continue;
			}
			if (
				counted === undefined ||
				checkedAt > countedAt ||
				(checkedAt === countedAt &&
					severity(entry.outcome) > severity(counted.outcome))
			) {
				counted = entry;
				countedAt = checkedAt;
			}
		}
		if (unplaced || counted === undefined) continue;
		if (counted.outcome !== "pass") {
			reasons.push({
				code: "EVIDENCE_FAILED",
				detail: `conformance for ${engine} is ${counted.outcome}`,
			});
			continue;
		}
		if (Number(now - countedAt) > maxAgeMicros) {
			reasons.push({
				code: "EVIDENCE_STALE",
				detail: `conformance for ${engine} was last checked ${counted.checkedAt}`,
			});
		}
	}
	return reasons;
}

/**
 * An estimate a gate may use: a finite number, zero or more. `NaN` compares
 * false against every budget and a negative is under every budget, so either
 * would walk through a `>` check; neither is an estimate.
 */
function usableEstimate(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function freezeMs(
	pattern: MigrationPattern,
	estimates: SelectionEstimates | undefined,
): number | undefined {
	if (pattern.writeFreeze === "none") return 0;
	return usableEstimate(
		pattern.writeFreeze === "bounded" ? estimates?.flipMs : estimates?.copyMs,
	);
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
	now: bigint,
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
	const native = realization === "native";
	{
		const sourcePorts = pattern.sourcePorts.filter(
			(port) => !native || !NATIVE_TRANSPORT_PORTS.source.includes(port),
		);
		const targetPorts = pattern.targetPorts.filter(
			(port) => !native || !NATIVE_TRANSPORT_PORTS.target.includes(port),
		);
		const missingSource =
			needsSource && request.source !== undefined
				? hasPorts(request.source, sourcePorts)
				: [];
		const missingTarget =
			needsTarget && request.target !== undefined
				? hasPorts(request.target, targetPorts)
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
	}
	if (!native) {
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
			detail: `${pattern.id} refuses writes (${pattern.writeFreeze}) and no usable estimate was supplied: a finite number of milliseconds, zero or more`,
		});
	} else if (estimatedFreeze > request.constraints.maxWriteFreezeMs) {
		reasons.push({
			code: "FREEZE_EXCEEDS_BUDGET",
			detail: `${pattern.id} needs about ${estimatedFreeze} ms of refused writes; the budget is ${request.constraints.maxWriteFreezeMs} ms`,
		});
	}
	// A native realization carries no reverse tail: the engine's transport is
	// torn down at the cutover, so the old side goes stale there.
	const reverseTail =
		!native &&
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
	// The verdict judged the places its path named and no others. A pattern
	// that creates a copy the path left out — a relay, a retained change log,
	// a rollback snapshot, the retiring source — was never judged there, so an
	// `ok` verdict says nothing about it and the candidate is not eligible.
	const uncovered = uncoveredCustodyRoles(request.verdict, {
		pattern: pattern.id,
		realization,
		reverseTail,
	});
	if (uncovered.length > 0) {
		reasons.push({
			code: "CUSTODY_INCOMPLETE",
			detail: `${pattern.id} (${realization}) creates ${uncovered.join(", ")}; the custody path behind the verdict names no such point`,
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
	// An estimate that is not a finite, non-negative number is no estimate: it
	// ranks last, as an absent one does. Raw, a NaN compares neither below nor
	// above anything, so the order — and with it the selection — would depend
	// on where the candidate happened to stand in the list; a negative one
	// would win.
	const custody = usableEstimate(estimates?.custodyPoints?.[candidate.pattern]);
	const cost = usableEstimate(estimates?.costMinorUnits?.[candidate.pattern]);
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
	// Read strictly, never through `Date.parse`: an instant with no offset is
	// local time there, and the decision would depend on the host's time zone.
	const now = instantMicros(request.now);
	if (now === undefined) {
		invalid("now must be an RFC 3339 instant with an explicit offset", "now");
	}
	// Finite as well as non-negative: an infinite budget has no JSON form, so
	// it would enter the decision digest as `null`.
	if (usableEstimate(request.constraints.maxWriteFreezeMs) === undefined) {
		invalid(
			"maxWriteFreezeMs must be a finite number, zero or more",
			"constraints.maxWriteFreezeMs",
		);
	}
	if (usableEstimate(request.evidenceMaxAgeMs) === undefined) {
		invalid(
			"evidenceMaxAgeMs must be a finite number, zero or more",
			"evidenceMaxAgeMs",
		);
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
