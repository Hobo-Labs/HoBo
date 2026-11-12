// Version selection for subscriptions (D3): SemVer 2.0 ordering and ranges,
// allow/ignore patterns, and the forward-only "newest N above the high-water
// mark" rule. Pure: no clock, no I/O, deterministic for any input order.
import {
	SelectionStrategy,
	type SubscriptionRecord,
} from "../_generated/cd_pb.js";
import type { Outcome } from "../ports.js";
import { refuse, SOURCE_REASON } from "./reasons.js";

export type Semver = Readonly<{
	major: number;
	minor: number;
	patch: number;
	prerelease: readonly (string | number)[];
}>;

const SEMVER =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_LENGTH = 256;

export function parseSemver(version: string): Semver | undefined {
	if (version.length > MAX_VERSION_LENGTH) return undefined;
	const match = SEMVER.exec(version);
	if (!match) return undefined;
	const numbers = [match[1], match[2], match[3]].map(Number);
	if (numbers.some((item) => !Number.isSafeInteger(item))) return undefined;
	return {
		major: numbers[0] ?? 0,
		minor: numbers[1] ?? 0,
		patch: numbers[2] ?? 0,
		prerelease: match[4]
			? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
			: [],
	};
}

function compareIdentifier(left: string | number, right: string | number): number {
	const leftNumeric = Number.isInteger(left);
	const rightNumeric = Number.isInteger(right);
	if (leftNumeric && rightNumeric) return Number(left) - Number(right);
	if (leftNumeric) return -1;
	if (rightNumeric) return 1;
	return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

export function compareSemver(left: Semver, right: Semver): number {
	const core =
		left.major - right.major || left.minor - right.minor || left.patch - right.patch;
	if (core !== 0) return Math.sign(core);
	if (left.prerelease.length === 0 || right.prerelease.length === 0)
		return Math.sign(right.prerelease.length - left.prerelease.length);
	const length = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < length; index += 1) {
		const a = left.prerelease[index];
		const b = right.prerelease[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		const order = compareIdentifier(a, b);
		if (order !== 0) return Math.sign(order);
	}
	return 0;
}

function lexical(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Total order for one strategy. SEMVER puts unparseable versions below every
 * SemVer (they are filtered before selection anyway); the others are lexical.
 */
export function compareVersions(
	strategy: SelectionStrategy,
	left: string,
	right: string,
): number {
	if (strategy === SelectionStrategy.SEMVER) {
		const a = parseSemver(left);
		const b = parseSemver(right);
		if (a && b) return compareSemver(a, b) || lexical(left, right);
		if (a) return 1;
		if (b) return -1;
	}
	return lexical(left, right);
}

// ── Ranges ──────────────────────────────────────────────────────────────────

type Operator = "<" | "<=" | ">" | ">=" | "=";
type Comparator = Readonly<{ operator: Operator; version: Semver }>;

export type SemverRange = Readonly<{ source: string; test: (version: string) => boolean }>;

const PARTIAL = /^v?(\*|x|X|0|[1-9]\d*)(?:\.(\*|x|X|0|[1-9]\d*)(?:\.(\*|x|X|0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?)?)?$/;

type Partial = Readonly<{
	major?: number;
	minor?: number;
	patch?: number;
	prerelease: readonly (string | number)[];
}>;

function wildcard(part: string | undefined): boolean {
	return part === undefined || part === "*" || part === "x" || part === "X";
}

function parsePartial(text: string): Partial | undefined {
	const match = PARTIAL.exec(text);
	if (!match) return undefined;
	const [, major, minor, patch, pre] = match;
	const result: { major?: number; minor?: number; patch?: number; prerelease: (string | number)[] } = {
		prerelease: pre ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
	};
	if (!wildcard(major)) result.major = Number(major);
	if (result.major !== undefined && !wildcard(minor)) result.minor = Number(minor);
	if (result.minor !== undefined && !wildcard(patch)) result.patch = Number(patch);
	return result;
}

function sv(major: number, minor: number, patch: number, prerelease: readonly (string | number)[] = []): Semver {
	return { major, minor, patch, prerelease };
}

const ZERO_PRE = Object.freeze(["0"]);

function lowerOf(partial: Partial): Semver {
	return sv(partial.major ?? 0, partial.minor ?? 0, partial.patch ?? 0, partial.prerelease);
}

/** Expand one range token (caret, tilde, x-range, comparator) to comparators. */
function expand(token: string): readonly Comparator[] | undefined {
	const operatorMatch = /^(\^|~|<=|>=|<|>|=)?(.*)$/.exec(token);
	const operator = operatorMatch?.[1] ?? "";
	const partial = parsePartial(operatorMatch?.[2] ?? "");
	if (!partial) return undefined;
	const { major, minor, patch } = partial;
	if (major === undefined) return operator === "<" || operator === ">" ? [] : [];
	const exact = patch !== undefined;
	switch (operator) {
		case "^": {
			const lower = lowerOf(partial);
			const upper =
				major > 0 || minor === undefined
					? sv(major + 1, 0, 0, ZERO_PRE)
					: minor > 0 || patch === undefined
						? sv(0, minor + 1, 0, ZERO_PRE)
						: sv(0, 0, patch + 1, ZERO_PRE);
			return [
				{ operator: ">=", version: lower },
				{ operator: "<", version: upper },
			];
		}
		case "~": {
			const upper = minor === undefined ? sv(major + 1, 0, 0, ZERO_PRE) : sv(major, minor + 1, 0, ZERO_PRE);
			return [
				{ operator: ">=", version: lowerOf(partial) },
				{ operator: "<", version: upper },
			];
		}
		case "":
		case "=": {
			if (exact) return [{ operator: "=", version: lowerOf(partial) }];
			const upper = minor === undefined ? sv(major + 1, 0, 0, ZERO_PRE) : sv(major, minor + 1, 0, ZERO_PRE);
			return [
				{ operator: ">=", version: lowerOf(partial) },
				{ operator: "<", version: upper },
			];
		}
		case ">":
			if (exact) return [{ operator: ">", version: lowerOf(partial) }];
			return [
				{
					operator: ">=",
					version: minor === undefined ? sv(major + 1, 0, 0) : sv(major, minor + 1, 0),
				},
			];
		case ">=":
			return [{ operator: ">=", version: lowerOf(partial) }];
		case "<":
			return [{ operator: "<", version: exact ? lowerOf(partial) : sv(major, minor ?? 0, 0, ZERO_PRE) }];
		case "<=":
			if (exact) return [{ operator: "<=", version: lowerOf(partial) }];
			return [
				{
					operator: "<",
					version: minor === undefined ? sv(major + 1, 0, 0, ZERO_PRE) : sv(major, minor + 1, 0, ZERO_PRE),
				},
			];
		default:
			return undefined;
	}
}

function satisfies(version: Semver, comparator: Comparator): boolean {
	const order = compareSemver(version, comparator.version);
	switch (comparator.operator) {
		case "<":
			return order < 0;
		case "<=":
			return order <= 0;
		case ">":
			return order > 0;
		case ">=":
			return order >= 0;
		default:
			return order === 0;
	}
}

function sameTuple(left: Semver, right: Semver): boolean {
	return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function testSet(set: readonly Comparator[], version: Semver): boolean {
	if (!set.every((comparator) => satisfies(version, comparator))) return false;
	if (version.prerelease.length === 0) return true;
	// npm semantics: a prerelease satisfies only when some comparator names a
	// prerelease on the same major.minor.patch (synthetic `-0` bounds do not).
	return set.some(
		(comparator) =>
			comparator.version.prerelease.length > 0 &&
			comparator.version.prerelease !== ZERO_PRE &&
			sameTuple(comparator.version, version),
	);
}

const MAX_RANGE_LENGTH = 256;

export function parseSemverRange(source: string): Outcome<SemverRange> {
	const invalid = () =>
		refuse(
			SOURCE_REASON.invalid,
			`semver range ${JSON.stringify(source)} is not a valid range`,
			"use npm-style ranges: ^1.2.0, ~1.2, 1.x, >=1.0.0 <2.0.0, 1.0.0 - 1.4.0, joined with ||",
			"semverRange",
		);
	if (source.length > MAX_RANGE_LENGTH) return invalid();
	const sets: Comparator[][] = [];
	for (const alternative of source.split("||")) {
		const trimmed = alternative.trim();
		const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
		const comparators: Comparator[] = [];
		if (hyphen) {
			const low = expand(`>=${hyphen[1]}`);
			const high = expand(`<=${hyphen[2]}`);
			if (!low || !high) return invalid();
			comparators.push(...low, ...high);
		} else if (trimmed !== "") {
			for (const token of trimmed.replace(/(\^|~|<=|>=|<|>|=)\s+/g, "$1").split(/\s+/)) {
				const expanded = expand(token);
				if (!expanded) return invalid();
				comparators.push(...expanded);
			}
		}
		sets.push(comparators);
	}
	return {
		ok: true,
		value: {
			source,
			test: (version: string) => {
				const parsed = parseSemver(version);
				return parsed !== undefined && sets.some((set) => testSet(set, parsed));
			},
		},
	};
}

// ── Filters and selection ───────────────────────────────────────────────────

export type VersionFilter = Pick<
	SubscriptionRecord,
	"selection" | "allowPattern" | "ignorePatterns" | "semverRange"
>;

const MAX_PATTERN_LENGTH = 256;

/** Compile a subscription pattern; refuses oversized or invalid expressions. */
export function compilePattern(pattern: string, subject: string): Outcome<RegExp> {
	if (pattern.length > MAX_PATTERN_LENGTH)
		return refuse(
			SOURCE_REASON.invalid,
			`${subject} exceeds ${MAX_PATTERN_LENGTH} characters`,
			"shorten the pattern",
			subject,
		);
	try {
		return { ok: true, value: new RegExp(pattern, "u") };
	} catch (error) {
		return refuse(
			SOURCE_REASON.invalid,
			`${subject} is not a valid regular expression: ${error instanceof Error ? error.message : "invalid"}`,
			"fix the regular expression (JavaScript, unicode mode)",
			subject,
		);
	}
}

/** Whether a version passes the subscription's allow/ignore/range filters. */
export function versionAllowed(filter: VersionFilter, version: string): Outcome<string> {
	const skip = (message: string) =>
		refuse(SOURCE_REASON.filtered, message, "adjust allowPattern, ignorePatterns or semverRange", version);
	if (filter.allowPattern !== "") {
		const allow = compilePattern(filter.allowPattern, "allowPattern");
		if (!allow.ok) return allow;
		if (!allow.value.test(version)) return skip(`${version} does not match allowPattern`);
	}
	for (const pattern of filter.ignorePatterns) {
		const ignore = compilePattern(pattern, "ignorePatterns");
		if (!ignore.ok) return ignore;
		if (ignore.value.test(version)) return skip(`${version} matches ignore pattern ${pattern}`);
	}
	if (filter.selection === SelectionStrategy.SEMVER) {
		const parsed = parseSemver(version);
		if (!parsed) return skip(`${version} is not SemVer`);
		// Conservative default: a prerelease is discovered only when a range admits it.
		if (filter.semverRange === "" && parsed.prerelease.length > 0)
			return skip(`${version} is a prerelease and no semverRange admits prereleases`);
		if (filter.semverRange !== "") {
			const range = parseSemverRange(filter.semverRange);
			if (!range.ok) return range;
			if (!range.value.test(version)) return skip(`${version} is outside ${filter.semverRange}`);
		}
	}
	return { ok: true, value: version };
}

/**
 * Forward-only selection: versions strictly above `highWater`, the newest
 * `limit` of them, returned oldest first so they are recorded in order.
 */
export function selectNewest(
	strategy: SelectionStrategy,
	versions: readonly string[],
	limit: number,
	highWater?: string,
): readonly string[] {
	const unique = [...new Set(versions)];
	const above =
		highWater === undefined
			? unique
			: unique.filter((version) => compareVersions(strategy, version, highWater) > 0);
	above.sort((left, right) => compareVersions(strategy, left, right));
	return above.slice(Math.max(0, above.length - limit));
}
