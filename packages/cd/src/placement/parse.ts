// Parse boundaries for Placement definitions and score snapshots (parse,
// don't validate). data-models/placement.cue mirrors these rules.
import { create, toJson } from "@bufbuild/protobuf";
import {
	type PlacementRecord,
	PlacementRecordSchema,
	type ReasonRecord,
	type ScoreSnapshotRecord,
	ScoreSnapshotRecordSchema,
	TaintEffect,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, PLACEMENT_SCHEMA } from "../events.js";
import { CLAIM_NAME, SLUG, TAINT_KEY } from "../inventory/parse.js";
import { parseSelector } from "../inventory/selector.js";
import { parseTime, reason, sha256Digest } from "../inventory/support.js";
import type { Outcome } from "../ports.js";

export type ParsedPlacement = PlacementRecord & { readonly __brand: "cd.ParsedPlacement" };
export type ParsedScoreSnapshot = ScoreSnapshotRecord & { readonly __brand: "cd.ParsedScoreSnapshot" };

export const SCORE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
/** Placement names may not take this prefix: score snapshots share the placement stream family. */
export const SCORE_STREAM_PREFIX = "score-";
export const SPREAD_KEYS = ["yard", "provider", "region", "jurisdiction"] as const;

const LABEL_SPREAD = /^label:[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const REQUIRED_CLAIM = /^([^=]+)(=(.{0,256}))?$/u;

export function isSpreadKey(key: string): boolean {
	return (SPREAD_KEYS as readonly string[]).includes(key) || LABEL_SPREAD.test(key);
}

function invalid(subject: string, message: string, remediation: string): ReasonRecord {
	return reason("placement-invalid", message, remediation, subject);
}

/** `name` or `name=value`; undefined when malformed. */
export function parseRequiredClaim(entry: string): Readonly<{ name: string; value?: string }> | undefined {
	const match = REQUIRED_CLAIM.exec(entry);
	const name = match?.[1];
	if (name === undefined || !CLAIM_NAME.test(name)) return undefined;
	return match?.[2] === undefined ? { name } : { name, value: match[3] ?? "" };
}

export function parsePlacement(placement: PlacementRecord): Outcome<ParsedPlacement> {
	const reasons: ReasonRecord[] = [];
	if (placement.schemaVersion !== PLACEMENT_SCHEMA) {
		reasons.push(invalid("schemaVersion", `schemaVersion must be ${PLACEMENT_SCHEMA}`, `set schemaVersion to "${PLACEMENT_SCHEMA}"`));
	}
	if (!SLUG.test(placement.name) || placement.name.startsWith(SCORE_STREAM_PREFIX)) {
		reasons.push(invalid("name", `placement name "${placement.name}" is invalid`, `use a slug that does not start with "${SCORE_STREAM_PREFIX}"`));
	}
	if (placement.campSets.length === 0) {
		reasons.push(invalid("campSets", "a Placement names no Camp set", "list at least one Camp set bound by the Station's Rail"));
	}
	if (placement.campSets.some((name) => !SLUG.test(name)) || new Set(placement.campSets).size !== placement.campSets.length) {
		reasons.push(invalid("campSets", "campSets has an invalid or repeated name", "list each Camp set slug once"));
	}
	const predicate = parseSelector(placement.predicate, "predicate");
	if (!predicate.ok) reasons.push(...predicate.reasons);
	for (const entry of placement.requiredClaims) {
		if (parseRequiredClaim(entry) === undefined) {
			reasons.push(invalid("requiredClaims", `required claim "${entry}" is invalid`, "use `name` or `name=value`"));
		}
	}
	if (placement.count > CD_DEFAULTS.maxFanoutCamps) {
		reasons.push(invalid("count", `count ${placement.count} exceeds ${CD_DEFAULTS.maxFanoutCamps}`, "lower count or split the placement"));
	}
	const spreadKeys = new Set<string>();
	for (const spread of placement.spread) {
		if (!isSpreadKey(spread.topologyKey)) {
			reasons.push(invalid("spread", `spread key "${spread.topologyKey}" is unsupported`, "use yard, provider, region, jurisdiction or label:<key>"));
		}
		if (spreadKeys.has(spread.topologyKey)) {
			reasons.push(invalid("spread", `spread key "${spread.topologyKey}" is repeated`, "declare each spread key once"));
		}
		spreadKeys.add(spread.topologyKey);
		if (spread.maxGroups > 0 && spread.maxGroups < spread.minGroups) {
			reasons.push(invalid("spread", `spread ${spread.topologyKey} has maxGroups < minGroups`, "raise maxGroups or lower minGroups"));
		}
		if (placement.count > 0 && spread.minGroups > placement.count) {
			reasons.push(invalid("spread", `spread ${spread.topologyKey} needs ${spread.minGroups} groups but count is ${placement.count}`, "raise count or lower minGroups"));
		}
	}
	const scoreNames = new Set<string>();
	for (const weight of placement.scores) {
		if (!SCORE_NAME.test(weight.score) || scoreNames.has(weight.score)) {
			reasons.push(invalid("scores", `score "${weight.score}" is invalid or repeated`, "name each score once with a lowercase slug"));
		}
		scoreNames.add(weight.score);
		if (!Number.isFinite(weight.weight)) {
			reasons.push(invalid("scores", `score "${weight.score}" has a non-finite weight`, "use a finite weight"));
		}
	}
	for (const toleration of placement.tolerations) {
		if (!TAINT_KEY.test(toleration.key) || TaintEffect[toleration.effect] === undefined) {
			reasons.push(invalid("tolerations", `toleration "${toleration.key}" is invalid`, "name a taint key and an effect (UNSPECIFIED tolerates both)"));
		}
	}
	const groupNames = new Set<string>();
	for (const group of placement.groups) {
		if (!SLUG.test(group.name) || groupNames.has(group.name)) {
			reasons.push(invalid("groups", `group "${group.name}" is invalid or repeated`, "name each group once with a slug"));
		}
		groupNames.add(group.name);
		const selector = parseSelector(group.selector, `groups.${group.name}.selector`);
		if (!selector.ok) reasons.push(...selector.reasons);
		if (group.maxSizePercent > 100) {
			reasons.push(invalid("groups", `group "${group.name}" maxSizePercent exceeds 100`, "use 0-100"));
		}
	}
	if (placement.defaultGroupSize > 0 && placement.defaultGroupSizePercent > 0) {
		reasons.push(invalid("defaultGroupSize", "defaultGroupSize and defaultGroupSizePercent are both set", "set one of them"));
	}
	if (placement.defaultGroupSizePercent > 100) {
		reasons.push(invalid("defaultGroupSizePercent", "defaultGroupSizePercent exceeds 100", "use 0-100"));
	}
	if (reasons.length > 0) return { ok: false, reasons };
	// SAFETY: every field was checked above; the brand records that.
	return { ok: true, value: create(PlacementRecordSchema, placement) as ParsedPlacement };
}

/** Content digest of a score snapshot over everything but the digest itself. */
export function scoreDigest(snapshot: ScoreSnapshotRecord): `sha256:${string}` {
	return sha256Digest(toJson(ScoreSnapshotRecordSchema, { ...snapshot, digest: "" }));
}

/**
 * Parse a reported score snapshot at `atMs`: it must be unexpired, valid for
 * at most `scoreMaxValidityMs`, and carry finite values only. The caller
 * stamps `reported_by`/`reported_at` before computing the digest.
 */
export function parseScoreSnapshot(snapshot: ScoreSnapshotRecord, atMs: number): Outcome<ParsedScoreSnapshot> {
	const reasons: ReasonRecord[] = [];
	if (!SCORE_NAME.test(snapshot.score)) {
		reasons.push(reason("score-invalid", `score name "${snapshot.score}" is invalid`, "use a lowercase slug", "score"));
	}
	const entries = Object.entries(snapshot.byCamp);
	if (entries.length === 0) {
		reasons.push(reason("score-invalid", "a score snapshot scores no Camp", "report at least one Camp's score", "byCamp"));
	}
	for (const [campId, value] of entries) {
		if (campId === "" || !Number.isFinite(value)) {
			reasons.push(reason("score-invalid", `score for "${campId}" is not finite`, "report finite numbers only", `byCamp.${campId}`));
		}
	}
	const until = parseTime(snapshot.validUntil);
	if (until === undefined || until <= atMs) {
		reasons.push(reason("score-expired", "validUntil is missing or already past", "report a validUntil in the future", "validUntil"));
	} else if (until - atMs > CD_DEFAULTS.scoreMaxValidityMs) {
		reasons.push(
			reason("score-invalid", `validUntil exceeds ${CD_DEFAULTS.scoreMaxValidityMs} ms from now`, "report scores valid for at most 24 h; re-report instead of extending", "validUntil"),
		);
	}
	if (reasons.length > 0) return { ok: false, reasons };
	// SAFETY: every field was checked above; the brand records that.
	return { ok: true, value: create(ScoreSnapshotRecordSchema, snapshot) as ParsedScoreSnapshot };
}
