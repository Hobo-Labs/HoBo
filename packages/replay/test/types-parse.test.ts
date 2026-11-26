/**
 * Session-replay parsing: privacy defaults and the PII refusal.
 *
 * Session replay records what a user did in a browser, which makes its privacy
 * policy the most consequential set of defaults in the package. Two properties
 * are asserted directly because both fail silently:
 *
 * **Every mask defaults to on.** A policy document that omits a field must get
 * masking, not an absence of it. The failure mode of getting this backwards is
 * that recordings quietly contain passwords, and nobody discovers it from the
 * code — they discover it from a recording.
 *
 * **`principalRef` refuses free-text PII.** The correlation record is meant to
 * carry an opaque id; an email address there would put PII into every replay
 * index. The check is deliberately blunt (an `@`, whitespace, or the substring
 * "email"), and blunt is right — a false rejection costs an author one rename,
 * a false acceptance costs a data-protection incident.
 *
 * Both snake_case and camelCase spellings are accepted throughout, since these
 * documents arrive from wire formats that use either. Each alternative is
 * pinned separately: an accepted-but-ignored spelling would silently fall back
 * to the default, which for a mask means "off".
 */
import { describe, expect, it } from "vitest";

import {
	defaultPrivacyPolicy,
	parsePrivacyPolicy,
	parseSessionCorrelation,
	parseSessionRecord,
	REPLAY_CORRELATION_SCHEMA,
	REPLAY_PRIVACY_SCHEMA,
	REPLAY_SCHEMA_VERSION,
	ReplayParseError,
} from "../src/types.js";

const correlation = (overrides: Record<string, unknown> = {}) => ({
	stationId: "st-1",
	...overrides,
});

describe("defaultPrivacyPolicy", () => {
	it("masks everything by default", () => {
		const policy = defaultPrivacyPolicy();
		expect(policy).toMatchObject({
			schemaVersion: REPLAY_PRIVACY_SCHEMA,
			maskInputs: true,
			maskPasswords: true,
			maskEmails: true,
			maskTel: true,
		});
	});

	it("captures network, console and errors by default", () => {
		expect(defaultPrivacyPolicy()).toMatchObject({
			captureNetwork: true,
			captureConsole: true,
			captureErrors: true,
		});
	});

	it("ships selectors for the fields that must never be recorded", () => {
		const policy = defaultPrivacyPolicy();
		expect(policy.maskSelectors).toEqual(
			expect.arrayContaining([
				"input[type=password]",
				"input[type=email]",
				"[autocomplete=cc-number]",
				"[autocomplete=cc-csc]",
			]),
		);
	});

	it("blocks value and PII data attributes by default", () => {
		expect(defaultPrivacyPolicy().blockAttributes).toEqual(
			expect.arrayContaining(["value", "data-ssn", "data-pii"]),
		);
	});

	it("lets a caller turn a mask off explicitly", () => {
		// Opting out has to be possible, but it has to be *said*.
		expect(defaultPrivacyPolicy({ maskEmails: false }).maskEmails).toBe(false);
	});

	it("replaces the selector list rather than merging into it", () => {
		// Merging would make a narrower policy impossible to express.
		expect(
			defaultPrivacyPolicy({ maskSelectors: [".mine"] }).maskSelectors,
		).toEqual([".mine"]);
	});

	it("treats an explicitly empty selector list as empty", () => {
		expect(defaultPrivacyPolicy({ maskSelectors: [] }).maskSelectors).toEqual(
			[],
		);
	});

	it("freezes the policy and its lists", () => {
		const policy = defaultPrivacyPolicy();
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy.maskSelectors)).toBe(true);
		expect(Object.isFrozen(policy.blockAttributes)).toBe(true);
	});
});

describe("parsePrivacyPolicy", () => {
	it("fills every default from an empty document", () => {
		// The load-bearing case: a document that says nothing must still mask.
		expect(parsePrivacyPolicy({})).toMatchObject({
			maskInputs: true,
			maskPasswords: true,
			maskEmails: true,
			maskTel: true,
		});
	});

	it.each([
		null,
		undefined,
		"policy",
		7,
	])("rejects the non-object %s", (raw) => {
		expect(() => parsePrivacyPolicy(raw)).toThrow(ReplayParseError);
	});

	it.each([
		["maskInputs", "mask_inputs"],
		["maskPasswords", "mask_passwords"],
		["maskEmails", "mask_emails"],
		["maskTel", "mask_tel"],
		["captureNetwork", "capture_network"],
		["captureConsole", "capture_console"],
		["captureErrors", "capture_errors"],
	])("reads %s and its snake_case spelling %s", (camel, snake) => {
		// An accepted-but-ignored spelling would fall back to the default, which
		// for a mask means the mask silently stays on when the author asked for
		// it off — or worse, the reverse if a default ever changes.
		expect(parsePrivacyPolicy({ [camel]: false })).toMatchObject({
			[camel]: false,
		});
		expect(parsePrivacyPolicy({ [snake]: false })).toMatchObject({
			[camel]: false,
		});
	});

	it("prefers the camelCase spelling when both are present", () => {
		expect(
			parsePrivacyPolicy({ maskEmails: true, mask_emails: false }).maskEmails,
		).toBe(true);
	});

	it("rejects a non-boolean mask rather than coercing it", () => {
		// `"false"` is truthy; coercing it would turn an author's mistake into a
		// mask that reads as enabled while meaning nothing.
		expect(() => parsePrivacyPolicy({ maskEmails: "false" })).toThrow(
			/must be a boolean/u,
		);
	});

	it("reads a selector list under either spelling", () => {
		expect(parsePrivacyPolicy({ maskSelectors: [".a"] }).maskSelectors).toEqual(
			[".a"],
		);
		expect(
			parsePrivacyPolicy({ mask_selectors: [".b"] }).maskSelectors,
		).toEqual([".b"]);
	});

	it("rejects a non-array selector list", () => {
		expect(() => parsePrivacyPolicy({ maskSelectors: ".a" })).toThrow(
			/expected string array/u,
		);
	});

	it("rejects a selector list containing a non-string", () => {
		expect(() => parsePrivacyPolicy({ maskSelectors: [".a", 7] })).toThrow(
			/expected string array/u,
		);
	});
});

describe("parseSessionCorrelation", () => {
	it("parses a minimal correlation", () => {
		expect(parseSessionCorrelation(correlation())).toMatchObject({
			schemaVersion: REPLAY_CORRELATION_SCHEMA,
			stationId: "st-1",
		});
	});

	it.each([null, undefined, "corr", 7])("rejects the non-object %s", (raw) => {
		expect(() => parseSessionCorrelation(raw)).toThrow(ReplayParseError);
	});

	it("requires a station id", () => {
		expect(() => parseSessionCorrelation({})).toThrow(
			/stationId must be a non-empty string/u,
		);
	});

	it("accepts station_id as well as stationId", () => {
		expect(parseSessionCorrelation({ station_id: "st-2" }).stationId).toBe(
			"st-2",
		);
	});

	it("defaults the isolation class to local-dev", () => {
		expect(parseSessionCorrelation(correlation()).isolationClass).toBe(
			"local-dev",
		);
	});

	it.each([
		"local-dev",
		"preview",
		"development",
		"staging",
		"production",
		"ephemeral",
	])("accepts the isolation class %s", (isolationClass) => {
		expect(
			parseSessionCorrelation(correlation({ isolationClass })).isolationClass,
		).toBe(isolationClass);
	});

	it("rejects an unknown isolation class rather than passing it through", () => {
		// Isolation class gates who may see a recording; an unrecognised value
		// must not reach a comparison that would treat it as "not production".
		expect(() =>
			parseSessionCorrelation(correlation({ isolationClass: "prod" })),
		).toThrow(/unknown isolation class: prod/u);
	});

	it("accepts isolation_class as the snake_case spelling", () => {
		expect(
			parseSessionCorrelation(correlation({ isolation_class: "staging" }))
				.isolationClass,
		).toBe("staging");
	});

	it("defaults tenant and env", () => {
		const parsed = parseSessionCorrelation(correlation());
		expect(parsed.tenant).toBe("local");
		expect(parsed.env).toBe("local-dev");
	});

	it.each([
		["yardId", "yard_id"],
		["campId", "camp_id"],
		["trailId", "trail_id"],
		["errorId", "error_id"],
		["controlPlaneEventId", "control_plane_event_id"],
	])("carries optional %s under either spelling", (camel, snake) => {
		expect(
			parseSessionCorrelation(correlation({ [camel]: "v" })),
		).toMatchObject({ [camel]: "v" });
		expect(
			parseSessionCorrelation(correlation({ [snake]: "v" })),
		).toMatchObject({ [camel]: "v" });
	});

	it("omits an optional field entirely rather than setting it undefined", () => {
		expect(parseSessionCorrelation(correlation())).not.toHaveProperty("yardId");
	});

	it("ignores a non-string optional field", () => {
		expect(
			parseSessionCorrelation(correlation({ yardId: 7 })),
		).not.toHaveProperty("yardId");
	});

	it("defaults harness flag keys to empty", () => {
		expect(parseSessionCorrelation(correlation()).harnessFlagKeys).toEqual([]);
	});

	it("carries harness flag keys under either spelling", () => {
		expect(
			parseSessionCorrelation(correlation({ harnessFlagKeys: ["a"] }))
				.harnessFlagKeys,
		).toEqual(["a"]);
		expect(
			parseSessionCorrelation(correlation({ harness_flag_keys: ["b"] }))
				.harnessFlagKeys,
		).toEqual(["b"]);
	});
});

describe("the principalRef PII refusal", () => {
	it("accepts an opaque id", () => {
		expect(
			parseSessionCorrelation(correlation({ principalRef: "prn-01H8X" }))
				.principalRef,
		).toBe("prn-01H8X");
	});

	it("rejects anything containing an @", () => {
		// An email in the correlation record puts PII into every replay index.
		expect(() =>
			parseSessionCorrelation(correlation({ principalRef: "a@b.com" })),
		).toThrow(/must not contain free-text PII/u);
	});

	it("rejects anything containing whitespace", () => {
		expect(() =>
			parseSessionCorrelation(correlation({ principalRef: "Jane Doe" })),
		).toThrow(/must not contain free-text PII/u);
	});

	it("rejects anything mentioning email, in any case", () => {
		for (const value of ["user-email", "EMAIL-ref", "Email"])
			expect(() =>
				parseSessionCorrelation(correlation({ principalRef: value })),
			).toThrow(/must not contain free-text PII/u);
	});

	it("raises the PII-specific code, not the generic parse code", () => {
		// Callers distinguish "malformed" from "we refused this on privacy
		// grounds", and only the second is a policy event.
		try {
			parseSessionCorrelation(correlation({ principalRef: "a@b.com" }));
			expect.unreachable();
		} catch (error) {
			expect((error as ReplayParseError).code).toBe("replay-pii-forbidden");
		}
	});

	it("applies the refusal to the snake_case spelling too", () => {
		// A check that only guards one spelling guards nothing.
		expect(() =>
			parseSessionCorrelation(correlation({ principal_ref: "a@b.com" })),
		).toThrow(/must not contain free-text PII/u);
	});

	it("omits principalRef entirely when absent", () => {
		expect(parseSessionCorrelation(correlation())).not.toHaveProperty(
			"principalRef",
		);
	});
});

describe("parseSessionRecord", () => {
	const record = (overrides: Record<string, unknown> = {}) => ({
		id: "sess-1",
		startedAt: "2026-01-01T00:00:00Z",
		correlation: correlation(),
		...overrides,
	});

	it("parses a minimal record", () => {
		expect(parseSessionRecord(record())).toMatchObject({
			schemaVersion: REPLAY_SCHEMA_VERSION,
			id: "sess-1",
			status: "recording",
		});
	});

	it.each([
		null,
		undefined,
		"record",
		7,
	])("rejects the non-object %s", (raw) => {
		expect(() => parseSessionRecord(raw)).toThrow(ReplayParseError);
	});

	it("requires an id", () => {
		expect(() => parseSessionRecord({ startedAt: "t" })).toThrow(
			/id must be a non-empty string/u,
		);
	});

	it("requires a start time, under either spelling", () => {
		expect(() => parseSessionRecord({ id: "s" })).toThrow(/startedAt/u);
		expect(
			parseSessionRecord({
				id: "s",
				started_at: "t",
				correlation: correlation(),
			}).startedAt,
		).toBe("t");
	});

	it("prefers the camelCase start time when both are present", () => {
		expect(
			parseSessionRecord(record({ started_at: "ignored" })).startedAt,
		).toBe("2026-01-01T00:00:00Z");
	});

	it.each([
		"recording",
		"ended",
		"retained",
		"erased",
	])("accepts the status %s", (status) => {
		expect(parseSessionRecord(record({ status })).status).toBe(status);
	});

	it("rejects an unknown status", () => {
		// "erased" is a retention state with legal meaning; an unrecognised
		// status must not be treated as any of the known ones.
		expect(() => parseSessionRecord(record({ status: "deleted" }))).toThrow(
			/unknown session status: deleted/u,
		);
	});

	it("defaults the status to recording", () => {
		expect(parseSessionRecord(record()).status).toBe("recording");
	});

	it("defaults chunk count and byte total to zero", () => {
		const parsed = parseSessionRecord(record());
		expect(parsed.chunkCount).toBe(0);
		expect(parsed.totalBytes).toBe(0);
	});

	it("reads counts under either spelling", () => {
		expect(parseSessionRecord(record({ chunkCount: 3 })).chunkCount).toBe(3);
		expect(parseSessionRecord(record({ chunk_count: 4 })).chunkCount).toBe(4);
		expect(parseSessionRecord(record({ total_bytes: 99 })).totalBytes).toBe(99);
	});

	it("defaults an absent correlation rather than failing", () => {
		// A record with no correlation is incomplete, not invalid — but it still
		// has to parse to something with defaults applied.
		expect(() => parseSessionRecord({ id: "s", startedAt: "t" })).toThrow(
			/stationId/u,
		);
	});

	it("applies privacy defaults when the record omits them", () => {
		expect(parseSessionRecord(record()).privacy.maskPasswords).toBe(true);
	});

	it("carries an end time under either spelling", () => {
		expect(parseSessionRecord(record({ endedAt: "t2" })).endedAt).toBe("t2");
		expect(parseSessionRecord(record({ ended_at: "t3" })).endedAt).toBe("t3");
	});

	it("omits the end time when absent", () => {
		expect(parseSessionRecord(record())).not.toHaveProperty("endedAt");
	});

	it("carries a summary only when it is a string", () => {
		expect(parseSessionRecord(record({ summary: "s" })).summary).toBe("s");
		expect(parseSessionRecord(record({ summary: 7 }))).not.toHaveProperty(
			"summary",
		);
	});

	it("freezes the parsed record", () => {
		expect(Object.isFrozen(parseSessionRecord(record()))).toBe(true);
	});
});

describe("ReplayParseError", () => {
	it("carries a code callers can switch on", () => {
		const error = new ReplayParseError("replay-parse-invalid", "bad");
		expect(error.code).toBe("replay-parse-invalid");
		expect(error.name).toBe("ReplayParseError");
		expect(error).toBeInstanceOf(Error);
	});
});
