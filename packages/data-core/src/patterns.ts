/**
 * The continuous-migration pattern catalog (ADR-0177 decision 5).
 *
 * Two questions pick a pattern family: who is the authority, and what
 * changes. The catalog is closed and versioned — adding a pattern is a
 * reviewed catalog change, the same rule the capability catalog follows —
 * and it is pure data, so it can be printed, diffed, and digested into every
 * decision that was made against it.
 *
 * Application-level dual-write is deliberately absent. Two independent writes
 * with no shared transaction diverge on the first partial failure, silently.
 * Every pattern here keeps exactly one write authority at any log position.
 */
import { digestOf, type JsonObject } from "./json.js";
import type { SpiPortName } from "./spi.js";

// public-contract: the schema id the pattern catalog is published under.
export const PATTERN_CATALOG_CONTRACT = "hobo.migration-pattern-catalog/v1";

/** Who holds the truth for the data being moved. */
export const AUTHORITIES = ["projected", "authoritative", "journal"] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** What a migration changes about the data. */
export const CHANGE_KINDS = [
	"shape",
	"placement",
	"engine",
	"paradigm",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const MIGRATION_PATTERNS = [
	"in-place-evolve",
	"rebuild-and-swap",
	"offline-copy",
	"snapshot-and-tail",
	"log-pivot",
	"stream-handoff",
] as const;
export type MigrationPatternId = (typeof MIGRATION_PATTERNS)[number];

/** One ordered phase list; every pattern is a subset of it. */
export const MIGRATION_PHASES = [
	"plan",
	"gate",
	"prepare",
	"seed",
	"converge",
	"verify",
	"shift-reads",
	"fence-and-flip",
	"soak",
	"finalize",
] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/**
 * A safe hold is a phase a migration can sit in indefinitely without losing
 * data or violating policy. Only the fence-and-flip step is not one: it is
 * bounded and either completes or compensates.
 */
export const SAFE_HOLD_PHASES: readonly MigrationPhase[] = Object.freeze([
	"plan",
	"gate",
	"prepare",
	"seed",
	"converge",
	"verify",
	"shift-reads",
	"soak",
]);

/**
 * - `lossless`: the side being abandoned is still current.
 * - `to-snapshot`: writes since the snapshot or flip are lost on rollback.
 * - `none`: no rollback remains.
 */
export const ROLLBACK_POSTURES = ["none", "to-snapshot", "lossless"] as const;
export type RollbackPosture = (typeof ROLLBACK_POSTURES)[number];

/**
 * - `none`: writes are never refused.
 * - `bounded`: writes are refused only for the fence-and-flip step.
 * - `window`: writes are refused for the whole copy.
 */
export const WRITE_FREEZES = ["none", "bounded", "window"] as const;
export type WriteFreeze = (typeof WRITE_FREEZES)[number];

// domain-view: catalog entry; wire form is MigrationPattern in data-models/data_core.proto.
export interface MigrationPattern {
	readonly id: MigrationPatternId;
	readonly summary: string;
	readonly authorities: readonly Authority[];
	readonly changes: readonly ChangeKind[];
	readonly phases: readonly MigrationPhase[];
	readonly sourcePorts: readonly SpiPortName[];
	readonly targetPorts: readonly SpiPortName[];
	/**
	 * Ports that upgrade the soak-window rollback from `to-snapshot` to
	 * `lossless` when both are present: capture on the target and apply on the
	 * source — a reverse tail.
	 */
	readonly reverseTailPorts: {
		readonly source: readonly SpiPortName[];
		readonly target: readonly SpiPortName[];
	};
	readonly writeFreeze: WriteFreeze;
	readonly rollbackBeforeFlip: RollbackPosture;
	/** Soak-window posture without, and with, a reverse tail. */
	readonly rollbackInSoak: RollbackPosture;
	readonly rollbackInSoakWithReverseTail: RollbackPosture;
	/** `log` when the pattern permanently moves authority into the event log. */
	readonly authorityAfter: "unchanged" | "log";
}

function pattern(entry: MigrationPattern): MigrationPattern {
	return Object.freeze({
		...entry,
		authorities: Object.freeze([...entry.authorities]),
		changes: Object.freeze([...entry.changes]),
		phases: Object.freeze([...entry.phases]),
		sourcePorts: Object.freeze([...entry.sourcePorts]),
		targetPorts: Object.freeze([...entry.targetPorts]),
		reverseTailPorts: Object.freeze({
			source: Object.freeze([...entry.reverseTailPorts.source]),
			target: Object.freeze([...entry.reverseTailPorts.target]),
		}),
	});
}

const NO_REVERSE_TAIL = { source: [], target: [] } as const;

export const PATTERN_CATALOG: readonly MigrationPattern[] = Object.freeze([
	pattern({
		id: "in-place-evolve",
		summary:
			"Expand, backfill, then contract inside the live store; old and new application versions both run through the dual window.",
		authorities: ["authoritative", "projected"],
		changes: ["shape"],
		phases: ["plan", "gate", "prepare", "seed", "verify", "finalize"],
		sourcePorts: ["schema"],
		targetPorts: [],
		reverseTailPorts: NO_REVERSE_TAIL,
		writeFreeze: "none",
		rollbackBeforeFlip: "lossless",
		rollbackInSoak: "to-snapshot",
		rollbackInSoakWithReverseTail: "to-snapshot",
		authorityAfter: "unchanged",
	}),
	pattern({
		id: "rebuild-and-swap",
		summary:
			"Provision a new sink, replay the event log into it, converge to the live position, verify, flip the read binding, reap the old sink.",
		authorities: ["projected"],
		changes: ["shape", "placement", "engine", "paradigm"],
		phases: [
			"plan",
			"gate",
			"prepare",
			"seed",
			"converge",
			"verify",
			"shift-reads",
			"soak",
			"finalize",
		],
		sourcePorts: [],
		targetPorts: ["datasets", "records", "apply", "verify"],
		reverseTailPorts: NO_REVERSE_TAIL,
		writeFreeze: "none",
		rollbackBeforeFlip: "lossless",
		rollbackInSoak: "lossless",
		rollbackInSoakWithReverseTail: "lossless",
		authorityAfter: "unchanged",
	}),
	pattern({
		id: "offline-copy",
		summary:
			"Fence writes, copy a snapshot, verify, flip, release. Simple and exact, at the price of refusing writes for the whole copy.",
		authorities: ["authoritative"],
		changes: ["placement", "engine"],
		phases: ["plan", "gate", "prepare", "fence-and-flip", "soak", "finalize"],
		sourcePorts: ["snapshot", "verify", "fence", "retire"],
		targetPorts: ["datasets", "records", "apply", "verify"],
		reverseTailPorts: { source: ["apply"], target: ["capture"] },
		writeFreeze: "window",
		rollbackBeforeFlip: "lossless",
		rollbackInSoak: "to-snapshot",
		rollbackInSoakWithReverseTail: "lossless",
		authorityAfter: "unchanged",
	}),
	pattern({
		id: "snapshot-and-tail",
		summary:
			"Seed from a snapshot, tail captured changes until lag is within bound, verify, shift reads, fence and flip write authority once, then tail in reverse through the soak window.",
		authorities: ["authoritative"],
		changes: ["placement", "engine"],
		phases: [
			"plan",
			"gate",
			"prepare",
			"seed",
			"converge",
			"verify",
			"shift-reads",
			"fence-and-flip",
			"soak",
			"finalize",
		],
		sourcePorts: ["snapshot", "capture", "verify", "fence", "retire"],
		targetPorts: ["datasets", "records", "apply", "verify"],
		reverseTailPorts: { source: ["apply"], target: ["capture"] },
		writeFreeze: "bounded",
		rollbackBeforeFlip: "lossless",
		rollbackInSoak: "to-snapshot",
		rollbackInSoakWithReverseTail: "lossless",
		authorityAfter: "unchanged",
	}),
	pattern({
		id: "log-pivot",
		summary:
			"Adopt an authoritative store, capture its changes into the event log as domain events, then serve the target as a projection of the log. Authority moves to the log permanently.",
		authorities: ["authoritative"],
		changes: ["paradigm", "engine"],
		phases: [
			"plan",
			"gate",
			"prepare",
			"seed",
			"converge",
			"verify",
			"fence-and-flip",
			"finalize",
		],
		sourcePorts: ["snapshot", "capture", "fence"],
		targetPorts: ["datasets", "records", "apply", "verify"],
		reverseTailPorts: NO_REVERSE_TAIL,
		writeFreeze: "bounded",
		rollbackBeforeFlip: "lossless",
		rollbackInSoak: "none",
		rollbackInSoakWithReverseTail: "none",
		authorityAfter: "log",
	}),
	pattern({
		id: "stream-handoff",
		summary:
			"Copy event streams to a new store by position, quiesce the single writer, drain the tail, flip the writer.",
		authorities: ["journal"],
		changes: ["placement", "engine"],
		phases: [
			"plan",
			"gate",
			"prepare",
			"seed",
			"converge",
			"verify",
			"fence-and-flip",
			"finalize",
		],
		sourcePorts: [],
		targetPorts: [],
		reverseTailPorts: NO_REVERSE_TAIL,
		writeFreeze: "bounded",
		rollbackBeforeFlip: "lossless",
		rollbackInSoak: "to-snapshot",
		rollbackInSoakWithReverseTail: "to-snapshot",
		authorityAfter: "unchanged",
	}),
]);

export function getPattern(id: MigrationPatternId): MigrationPattern {
	const found = PATTERN_CATALOG.find((entry) => entry.id === id);
	if (found === undefined) {
		// Unreachable for a typed id; kept so a widened caller fails loudly.
		throw new RangeError(`unknown migration pattern ${id}`);
	}
	return found;
}

export function isMigrationPatternId(
	value: string,
): value is MigrationPatternId {
	// SAFETY: membership test against the closed tuple of pattern ids.
	return (MIGRATION_PATTERNS as readonly string[]).includes(value);
}

/** Patterns legal for an authority and a kind of change, in catalog order. */
export function patternsFor(
	authority: Authority,
	change: ChangeKind,
): readonly MigrationPattern[] {
	return PATTERN_CATALOG.filter(
		(entry) =>
			entry.authorities.includes(authority) && entry.changes.includes(change),
	);
}

export function patternToJson(entry: MigrationPattern): JsonObject {
	return {
		id: entry.id,
		summary: entry.summary,
		authorities: [...entry.authorities],
		changes: [...entry.changes],
		phases: [...entry.phases],
		sourcePorts: [...entry.sourcePorts],
		targetPorts: [...entry.targetPorts],
		reverseTailPorts: {
			source: [...entry.reverseTailPorts.source],
			target: [...entry.reverseTailPorts.target],
		},
		writeFreeze: entry.writeFreeze,
		rollbackBeforeFlip: entry.rollbackBeforeFlip,
		rollbackInSoak: entry.rollbackInSoak,
		rollbackInSoakWithReverseTail: entry.rollbackInSoakWithReverseTail,
		authorityAfter: entry.authorityAfter,
	};
}

/**
 * Digest of the whole catalog. Every decision records it, so a change of
 * selected pattern is attributable to a catalog change rather than to
 * nondeterminism (the ADR-0144 catalog-hash discipline).
 */
export function patternCatalogDigest(): `sha256:${string}` {
	return digestOf({
		contract: PATTERN_CATALOG_CONTRACT,
		patterns: PATTERN_CATALOG.map((entry) => patternToJson(entry)),
	});
}

export function isSafeHold(phase: MigrationPhase): boolean {
	return SAFE_HOLD_PHASES.includes(phase);
}

export function phaseIndex(phase: MigrationPhase): number {
	return MIGRATION_PHASES.indexOf(phase);
}
