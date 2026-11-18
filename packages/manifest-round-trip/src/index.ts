
import { createHash } from "node:crypto";

export const ROUND_TRIP_REPORT_SCHEMA = "hobo.manifest-round-trip/v1" as const;

export const CHECK_OUTCOMES = [
	"single-declaration",
	"parity",
	"divergent",
] as const;

export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

declare const roundTripReportBrand: unique symbol;

export type ManifestCheck = {
	readonly shape: string;
	readonly owner: string;
	readonly upstream: string;
	readonly outcome: CheckOutcome;
	readonly detail: string;
};

export type RoundTripReport = {
	readonly schema: typeof ROUND_TRIP_REPORT_SCHEMA;
	readonly checks: readonly ManifestCheck[];
	readonly [roundTripReportBrand]: "RoundTripReport";
};

export type ReportHash = `sha256:${string}`;

export class RoundTripReportError extends Error {
	readonly code = "INVALID_ROUND_TRIP_REPORT" as const;
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

export function canonicalRoundTripReportJson(report: RoundTripReport): string {
	return JSON.stringify(sortKeys(report));
}

export function hashRoundTripReport(report: RoundTripReport): ReportHash {
	return `sha256:${createHash("sha256")
		.update(canonicalRoundTripReportJson(report))
		.digest("hex")}`;
}
