/**
 * `@hobo/manifest-round-trip` — the cross-manifest verification package.
 *
 * Each of the four manifest packages proves its own shape round-trips against
 * its own fixtures. None of them can prove the thing that actually matters
 * after a decomposition: that the shape which moved is *the same shape* the
 * package it moved out of still hands to its callers, and that the packages
 * still compose. That is this package's only job, and it is why nothing
 * depends on it.
 *
 * It deliberately does **not** depend on `@hobo/cloud`. `@hobo/cloud` is a
 * layer-3 application package; an edge to it from here is an
 * `outward-dependency` the boundary gate refuses. Cloud's committed fixtures
 * and its pinned digests are therefore read as *data* — the JSON from
 * `packages/cloud/test/fixtures/`, the digest constants out of the text of
 * cloud's own test files — which is stricter than importing them would be,
 * because a copied constant cannot drift from the file it was copied from
 * while a read one can.
 *
 * Parse, don't validate. {@link RoundTripReport} is the parsed derived domain
 * type this package produces; `data-models/round_trip_report.proto` is its wire
 * form and `data-models/round_trip_report.cue` the constraint set.
 * {@link parseRoundTripReport} is the only way to obtain one — it is branded,
 * so a raw record cannot be cast into a report and no reader re-validates.
 *
 * ### Where this sits in the event architecture
 *
 * Nowhere, and that is the point worth stating rather than eliding. A
 * decomposition check is not a command and produces no event: no actor handles
 * it, nothing is appended to the event store, no projection folds it into a
 * materialized view or a read store, and no snapshot records it. It runs in
 * CI, over source text and committed fixtures, and its output is a report a
 * human reads. A verification package that started writing to a stream would
 * be a verification package that can change what it verifies.
 */

import { createHash } from "node:crypto";

// The schema discriminant of a round-trip report. Hashed into the report
// digest, so a consumer pins this exact string rather than deriving it.
// public-contract: round-trip report schema discriminant, part of every digest.
export const ROUND_TRIP_REPORT_SCHEMA = "hobo.manifest-round-trip/v1" as const;

/**
 * What a check found.
 *
 * - `single-declaration` — the shape is declared once, in the manifest package,
 *   and the upstream package re-exports it. Nothing can drift.
 * - `parity` — the shape is still declared in both places and the two
 *   declarations agree field for field, optionality included.
 * - `divergent` — declared in both places and they do not agree. Not a test
 *   failure by itself: a recorded, named divergence with a reason is the
 *   honest state when closing it is outside the closing party's reach. A
 *   divergence with no `detail` is refused.
 */
// public-contract: the three outcomes a decomposition check can report; pinned in the CUE and the proto enum.
export const CHECK_OUTCOMES = [
	"single-declaration",
	"parity",
	"divergent",
] as const;

export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

declare const roundTripReportBrand: unique symbol;

// domain-view: parsed decomposition check; wire form is ManifestCheck in data-models/round_trip_report.proto.
export type ManifestCheck = {
	/** The exported name that moved, e.g. `ResourceIntent`. */
	readonly shape: string;
	/** The package that owns it now, e.g. `@hobo/manifest-declaration`. */
	readonly owner: string;
	/** Repo-relative path of the file it moved out of. */
	readonly upstream: string;
	readonly outcome: CheckOutcome;
	/** Required on `divergent`, and refused as empty on any outcome. */
	readonly detail: string;
};

// domain-view: parsed decomposition report; wire form is RoundTripReport in data-models/round_trip_report.proto.
export type RoundTripReport = {
	readonly schema: typeof ROUND_TRIP_REPORT_SCHEMA;
	readonly checks: readonly ManifestCheck[];
	readonly [roundTripReportBrand]: "RoundTripReport";
};

export type ReportHash = `sha256:${string}`;

export class RoundTripReportError extends Error {
	readonly code = "INVALID_ROUND_TRIP_REPORT" as const;
	/** Dotted path of the offending field, e.g. `checks[2].detail`. */
	readonly path: string;

	constructor(path: string, detail: string) {
		super(`invalid round trip report at ${path}: ${detail}`);
		this.name = "RoundTripReportError";
		this.path = path;
	}
}

const CHECK_KEYS = ["shape", "owner", "upstream", "outcome", "detail"] as const;

function fail(path: string, detail: string): never {
	throw new RoundTripReportError(path, detail);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(path, `expected an object, got ${describe(value)}`);
	}
	return value as Record<string, unknown>;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "an array";
	return `${typeof value} ${JSON.stringify(value)}`;
}

function nonEmptyString(
	source: Record<string, unknown>,
	key: string,
	path: string,
): string {
	if (!Object.hasOwn(source, key)) fail(`${path}.${key}`, "is required");
	const value = source[key];
	if (typeof value !== "string") {
		fail(`${path}.${key}`, `expected a string, got ${describe(value)}`);
	}
	if (value.length === 0) fail(`${path}.${key}`, "must not be empty");
	return value;
}

function parseCheck(input: unknown, path: string): ManifestCheck {
	const source = objectAt(input, path);
	for (const key of Object.keys(source)) {
		if (!(CHECK_KEYS as readonly string[]).includes(key)) {
			fail(`${path}.${key}`, "is not a field of ManifestCheck");
		}
	}
	const outcome = nonEmptyString(source, "outcome", path);
	if (!(CHECK_OUTCOMES as readonly string[]).includes(outcome)) {
		fail(
			`${path}.outcome`,
			`expected one of ${CHECK_OUTCOMES.join(", ")}, got ${JSON.stringify(outcome)}`,
		);
	}
	return Object.freeze({
		shape: nonEmptyString(source, "shape", path),
		owner: nonEmptyString(source, "owner", path),
		upstream: nonEmptyString(source, "upstream", path),
		outcome: outcome as CheckOutcome,
		detail: nonEmptyString(source, "detail", path),
	});
}

/**
 * The parse boundary. Refuses an unknown field, an empty string anywhere, an
 * outcome outside the closed set, and two checks naming the same shape — a
 * duplicated shape means one of the two records is stale and there is no way to
 * tell which.
 */
export function parseRoundTripReport(input: unknown): RoundTripReport {
	const source = objectAt(input, "$");
	for (const key of Object.keys(source)) {
		if (key !== "schema" && key !== "checks") {
			fail(`$.${key}`, "is not a field of RoundTripReport");
		}
	}
	const schema = nonEmptyString(source, "schema", "$");
	if (schema !== ROUND_TRIP_REPORT_SCHEMA) {
		fail(
			"$.schema",
			`expected ${JSON.stringify(ROUND_TRIP_REPORT_SCHEMA)}, got ${JSON.stringify(schema)}`,
		);
	}
	if (!Object.hasOwn(source, "checks")) fail("$.checks", "is required");
	const rawChecks = source.checks;
	if (!Array.isArray(rawChecks)) {
		fail("$.checks", `expected an array, got ${describe(rawChecks)}`);
	}
	if (rawChecks.length === 0) {
		fail(
			"$.checks",
			"must not be empty; a report with no checks proves nothing",
		);
	}
	const checks: ManifestCheck[] = [];
	const seen = new Set<string>();
	for (const [index, raw] of rawChecks.entries()) {
		const check = parseCheck(raw, `$.checks[${index}]`);
		if (seen.has(check.shape)) {
			fail(
				`$.checks[${index}].shape`,
				`duplicates ${JSON.stringify(check.shape)}`,
			);
		}
		seen.add(check.shape);
		checks.push(check);
	}
	return Object.freeze({
		schema: ROUND_TRIP_REPORT_SCHEMA,
		checks: Object.freeze(checks),
	}) as RoundTripReport;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort())
			out[key] = sortKeys(source[key]);
		return out;
	}
	return value;
}

/**
 * Canonical, key-sorted serialization.
 *
 * `Array.prototype.sort`'s default comparator, not `localeCompare` — the same
 * choice `@hobo/manifest-plan` makes and for the same reason: the two disagree
 * on keys differing only in case, and a digest that depends on ICU collation is
 * not reproducible across runtimes. The keys here are fixed, so the two agree
 * today; pinning the comparator is what keeps that true.
 */
export function canonicalRoundTripReportJson(report: RoundTripReport): string {
	return JSON.stringify(sortKeys(report));
}

export function hashRoundTripReport(report: RoundTripReport): ReportHash {
	return `sha256:${createHash("sha256")
		.update(canonicalRoundTripReportJson(report))
		.digest("hex")}`;
}
