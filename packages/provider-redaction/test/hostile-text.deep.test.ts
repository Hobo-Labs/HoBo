/**
 * The deep tier of the shared redactor (`pnpm run test:deep`): every shared
 * shape and detector swept over its own classes, fragments, repeated pieces
 * and periodic texts; the whole redactor's growth on every hostile input a
 * review found; a megabyte of each searched whole; and the measure's negative
 * controls, which must fail it. The fast tier screens the same hostile inputs
 * once each (`provider-redaction.test.ts`).
 */
import {
	asGlobal,
	assertPatternSweepLinear,
	assertSweepLinear,
	matchAllSearch,
	type PatternSearch,
	patternFragments,
	patternSpec,
	SweepGrowthError,
	type SweepSpec,
} from "@hobo/redaction-test-harness/linear-sweep";
import {
	grewLinearly,
	HANG_BACKSTOP_MS,
	LINEAR_GROWTH_LIMIT,
	measureGrowth,
	NEGATIVE_CONTROL,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
import {
	assertFindsNoLess,
	JWT_PIECES,
	PEM_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_PATTERNS,
	decodePercentFully,
	JSON_JWT_PATTERN,
	JWT_DETECTOR,
	JWT_PATTERN,
	PRIVATE_KEY_DETECTOR,
	PRIVATE_KEY_PATTERN,
	redactionPattern,
	redactMatches,
	redactProviderText,
} from "../src/provider-redaction.js";
import {
	adversarial,
	decodeByPasses,
	MB,
	PATTERN_NAMES,
	type PatternName,
	patternNamed,
} from "./adversarial.js";

function timed(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

/** A shape searched the way `redactMatches` searches it, made global. */
const searchAsRedactor: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

function expectLinear(
	run: (text: string) => void,
	text: (length: number) => string,
	what: string,
): void {
	const growth = measureGrowth(run, text);
	expect(grewLinearly(growth), `${what}: ${JSON.stringify(growth)}`).toBe(true);
}

// A growth measurement costs about a second of CPU; this is its backstop
// against the root config's 10 s test timeout on a slow or loaded runner.
const GROWTH_TIMEOUT_MS = 600_000;

describe("every pattern on a hostile text", () => {
	const searchedWhole = (text: string) => {
		redactProviderText(text, 8 * MB);
	};

	it.each(
		adversarial.map((entry) => [entry.name, entry] as const),
	)("%s: a megabyte searched whole returns, and by default the window bounds the output", (_case, entry) => {
		// Linearity is measured pattern by pattern below; this only catches a
		// hang in the redactor around them.
		const megabyte = entry.text(MB);
		expect(megabyte.length).toBeGreaterThanOrEqual(MB);
		expect(timed(() => searchedWhole(megabyte))).toBeLessThan(HANG_BACKSTOP_MS);
		expect(redactProviderText(megabyte).length).toBeLessThanOrEqual(257);
	});

	it(
		"the whole redactor grows linearly on a mix of every shape",
		() => {
			const mix = adversarial.find((entry) => entry.targets.length === 0);
			if (mix === undefined) throw new Error("no mixed input");
			expectLinear(searchedWhole, mix.text, mix.name);
		},
		GROWTH_TIMEOUT_MS,
	);

	// A match's value is searched again from its first whitespace, so a value
	// that went on to the end and was read again from every run (a chain of
	// `token: `, each a name and a separator) was quadratic.
	it.each([
		"token: ",
		"a: token: ",
		"**Token**: ",
		"api_key=password: ",
		"Bearer ",
		"authorization: bearer ",
		"-----BEGIN PRIVATE KEY----- ",
	])(
		"the whole redactor grows linearly on %j repeated",
		(unit) => {
			expectLinear(searchedWhole, repeatedTo(unit), unit);
		},
		GROWTH_TIMEOUT_MS,
	);

	// The sweep (`@hobo/redaction-test-harness/linear-sweep`): every pattern on runs of each
	// character class it reads, each pair of them, and its own words followed
	// by them, so no class is left out by whoever wrote the inputs above.
	const ALNUM = "aZ9";
	const SWEEP_SPECS = {
		"private key": {
			alphabet: ALNUM,
			words: [
				"-----BEGIN ",
				"-----BEGIN PRIVATE KEY-----",
				"-----END ",
				"-----END PRIVATE KEY-----",
				// A whole key, so a run and a literal after it come after one.
				"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
			],
		},
		jwt: {
			alphabet: `${ALNUM}ey`,
			words: ["ey", "-ey", "eyAAAAAAAAAA.", "eyAAAAAAAAAA.AAAAAAAAAA."],
		},
		"json jwt": {
			alphabet: `${ALNUM}eyJ`,
			words: ["eyJ", "-eyJ", "eyJAAAAAAAA.", "eyJAAAAAAAA.AAAAAAAA."],
		},
		bearer: { alphabet: ALNUM, words: ["Bearer", "Bearer "] },
		"authorization header": {
			alphabet: ALNUM,
			words: [
				"authorization",
				"authorization:",
				'authorization="',
				"Authorization: Basic",
			],
		},
		"basic or token": {
			alphabet: ALNUM,
			words: ["Basic ", "Token ", "Token Ab"],
		},
		"postgres url": {
			alphabet: ALNUM,
			words: ["postgres://", "prisma+postgres://", "postgresql:"],
		},
		"redis url": { alphabet: ALNUM, words: ["redis://", "rediss:"] },
		"mysql, mongodb or amqp url": {
			alphabet: ALNUM,
			words: ["mysql://", "mongodb+srv://", "amqps:"],
		},
		"url credentials": {
			alphabet: ALNUM,
			words: ["a://", "https://u:", "http://a:b"],
		},
		"inline credentials": { alphabet: ALNUM, words: ["//", "//a:", "//a:b"] },
		"secret key": {
			alphabet: ALNUM,
			words: [
				"token",
				"password=",
				"api_key:",
				'token="',
				"hobo-token://",
				"token: secret://",
			],
		},
		"locator tail": {
			alphabet: ALNUM,
			words: [
				"secret://camp/db",
				"secret://camp/db\\n",
				"token: hobo-token://a/b",
				"env://A_B",
			],
		},
		"prefixed key": {
			alphabet: ALNUM,
			words: ["sk_", "sk-", "ghp_", "xoxb-", "github_pat_"],
		},
	} satisfies Readonly<Record<PatternName, SweepSpec>>;

	it("every shared pattern has a sweep", () => {
		expect(CREDENTIAL_PATTERNS).toHaveLength(PATTERN_NAMES.length);
		expect(patternNamed("private key")).toBe(PRIVATE_KEY_PATTERN);
		expect(patternNamed("jwt")).toBe(JWT_PATTERN);
		expect(patternNamed("json jwt")).toBe(JSON_JWT_PATTERN);
		expect(Object.keys(SWEEP_SPECS).sort()).toEqual([...PATTERN_NAMES].sort());
	});

	it(
		"catches the private-key shape this replaced, B-1 in 0462fa6c",
		() => {
			// It read the run after an END line, then looked ahead for the next
			// END from every place it could give a character back.
			const replaced =
				/-----BEGIN[^-]*PRIVATE KEY-----(?:(?:(?!-----BEGIN)[\s\S])*(?:(?<!\S)|(?<=\\[nr]))-----END[^-]*PRIVATE KEY-----\S*(?=(?:(?!-----BEGIN|-----END)[\s\S])*(?:-----BEGIN|$))|(?:(?!-----BEGIN)[\s\S])*)/gi;
			expect(() =>
				assertSweepLinear(
					(text) => {
						text.replace(replaced, "");
					},
					{
						alphabet: "a",
						words: [
							"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
						],
						fragments: patternFragments(replaced),
					},
					{ failFast: true },
				),
			).toThrow(SweepGrowthError);
		},
		GROWTH_TIMEOUT_MS,
	);

	it.each(PATTERN_NAMES.map((name) => [name] as const))(
		"the %s pattern grows linearly on every class and pair of classes",
		(name) => {
			const pattern = patternNamed(name);
			// Through the search the redactor runs, which reads a match's value
			// again from the first whitespace in it, over the pattern's own
			// classes and fragments and the words listed here.
			assertPatternSweepLinear(
				pattern,
				searchAsRedactor,
				patternSpec(pattern, SWEEP_SPECS[name]),
			);
		},
		GROWTH_TIMEOUT_MS,
	);

	it.each([
		["the JWT detector", JWT_DETECTOR, SWEEP_SPECS.jwt],
		[
			"the private-key detector",
			PRIVATE_KEY_DETECTOR,
			SWEEP_SPECS["private key"],
		],
	] as const)(
		"%s grows linearly on every class and pair of classes",
		(_case, detector, spec) => {
			assertSweepLinear(
				(text) => {
					detector.test(text);
				},
				patternSpec(detector, spec),
			);
		},
		GROWTH_TIMEOUT_MS,
	);

	it(
		"percent-decoding nested %25 grows linearly",
		() => {
			// One layer of `%25` per pass for the old decoder: `%252525…41`.
			const nested = (length: number) => `%${"25".repeat(length / 2)}41`;
			expectLinear(
				(text) => {
					decodePercentFully(text);
				},
				nested,
				"decodePercentFully",
			);
		},
		GROWTH_TIMEOUT_MS,
	);

	// The measure has to tell the two apart, or the tests above prove nothing:
	// the patterns and the decoder they replaced must fail it. A quadratic shows
	// its 16x at a small size, so these are capped there (NEGATIVE_CONTROL).
	it.each([
		[
			"the old JWT pattern",
			/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.\S*/giu,
			repeatedTo("-ey"),
		],
		[
			"the old private-key pattern",
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
			repeatedTo("-----BEGIN PRIVATE KEY-----"),
		],
		[
			"the old secret-key prefix",
			/[A-Za-z0-9_-]*(?:access[_-]?token|auth[_-]?token|api[_-]?key)\s*[=:]\s*\S+/giu,
			repeatedTo("a"),
		],
	] as const)(
		"%s fails the measure",
		(_case, pattern, text) => {
			const growth = measureGrowth(
				(each) => {
					each.replace(pattern, "x");
				},
				text,
				NEGATIVE_CONTROL,
			);
			expect(growth.ratio, JSON.stringify(growth)).toBeGreaterThanOrEqual(
				LINEAR_GROWTH_LIMIT,
			);
		},
		GROWTH_TIMEOUT_MS,
	);

	// Round 5: three shapes the sweep built no input for. A literal over and
	// over (each copy starts a search that reads to the end), a look-ahead
	// gated on one, and a periodic text where only the long part of a period
	// lets a search start.
	it.each([
		["a group of a literal, repeated", /(?:xyz)+!/g],
		["a word and a run after it", /Bearer[^!]*!/g],
		["a look-ahead gated on a literal", /(?=(?:xyz)+!)x/g],
		["a period of one and seven", /ab{7}[ab]*!/g],
		["a period of one and sixty-three", /ab{63}[ab]*!/g],
	] as const)(
		"the sweep catches %s",
		(_case, pattern) => {
			expect(() =>
				assertPatternSweepLinear(
					pattern,
					matchAllSearch,
					patternSpec(pattern),
					{
						failFast: true,
					},
				),
			).toThrow(SweepGrowthError);
		},
		GROWTH_TIMEOUT_MS,
	);

	it(
		"the old decoder, again until nothing changes, fails the measure",
		() => {
			const growth = measureGrowth(
				(text) => {
					decodeByPasses(text);
				},
				(length) => `%${"25".repeat(length / 2)}41`,
				NEGATIVE_CONTROL,
			);
			expect(growth.ratio, JSON.stringify(growth)).toBeGreaterThanOrEqual(
				LINEAR_GROWTH_LIMIT,
			);
		},
		GROWTH_TIMEOUT_MS,
	);
});

// The detectors the claims, recipes, netlify-receipt and conformance guards
// had, as they stood before they took the shared ones: on 150k generated texts
// each, the shared detector finds every text the old one found.
describe("the shared detectors against the ones they replaced", () => {
	const finds = (pattern: RegExp) => (text: string) => pattern.test(text);
	it.each([
		[
			"the claims, recipes and netlify JWT detector",
			/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
			JWT_DETECTOR,
			JWT_PIECES,
		],
		[
			"the conformance JWT detector",
			/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
			JWT_DETECTOR,
			JWT_PIECES,
		],
		[
			"every guard's private-key detector",
			/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
			PRIVATE_KEY_DETECTOR,
			PEM_PIECES,
		],
	] as const)(
		"%s finds nothing the shared one misses",
		(_case, old, now, pieces) => {
			expect(assertFindsNoLess(finds(old), finds(now), pieces)).toBeGreaterThan(
				1000,
			);
		},
		GROWTH_TIMEOUT_MS,
	);

	it("a hostname with ey in it is not a JWT to either", () => {
		const host = "see my-eyewear-store.myshopify.com.example.internal.";
		expect(JWT_DETECTOR.test(host)).toBe(false);
		expect(redactProviderText(host)).toBe(host.trim());
	});
});
