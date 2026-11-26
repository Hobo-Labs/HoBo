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

export const MIGRATION_DECISION_CONTRACT = "hobo.migration-decision/v1";

export const REALIZATIONS = MIGRATION_REALIZATIONS;
export type Realization = MigrationRealization;

export const CONFORMANCE_OUTCOMES = ["pass", "fail", "unknown"] as const;
export type ConformanceOutcome = (typeof CONFORMANCE_OUTCOMES)[number];

export interface ConformanceEvidence {
	readonly engine: string;
	readonly outcome: ConformanceOutcome;
	readonly checkedAt: string;
}

export interface SelectionConstraints {
	readonly maxWriteFreezeMs: number;
	readonly requiredRollback: RollbackPosture;
}

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
	readonly schema?: DatasetSchema;
	readonly constraints: SelectionConstraints;
	readonly estimates?: SelectionEstimates;
	readonly verdict: PolicyVerdict;
	readonly waivers?: readonly string[];
	readonly evidence?: readonly ConformanceEvidence[];
	readonly now: string;
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
	readonly selected?: MigrationCandidate;
	readonly candidates: readonly MigrationCandidate[];
	readonly mappingFindings: readonly MappingFinding[];
	readonly catalogDigest: `sha256:${string}`;
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

export const NATIVE_TRANSPORT_PORTS: {
	readonly source: readonly SpiPortName[];
	readonly target: readonly SpiPortName[];
} = Object.freeze({
	source: Object.freeze(["snapshot", "capture"] as const),
	target: Object.freeze(["apply"] as const),
});

function severity(outcome: ConformanceOutcome): number {
	if (outcome === "pass") return 0;
	return outcome === "unknown" ? 1 : 2;
}

function evidenceReasons(
	request: SelectionRequest,
	now: bigint,
	engines: readonly string[],
): SelectionReason[] {
	const reasons: SelectionReason[] = [];
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

export function selectMigrationPattern(
	request: SelectionRequest,
): MigrationDecision {
	const now = instantMicros(request.now);
	if (now === undefined) {
		invalid("now must be an RFC 3339 instant with an explicit offset", "now");
	}
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
