/**
 * The shared provider redactor: every pattern linear in a hostile text, the
 * window and its cut, the profile a provider extends it with, and the
 * one-pass percent-decoding.
 *
 * Ported from provider-vercel's hostile-text tests, where the patterns first
 * became linear: the JWT pattern could start at every `ey` and run to the end
 * (100 kB of `-ey` took about ten seconds), and the private-key pattern
 * searched from every BEGIN for an END that never came.
 *
 * Linear means the cost grows about 4x from n to 4n characters, measured by
 * `measureGrowth` (`@hobo/core/linear-time`), so no verdict here depends on
 * how fast or how loaded the machine is. The one absolute bound is the 20 s
 * backstop on a single megabyte run, which only a hang reaches.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	grewLinearly,
	HANG_BACKSTOP_MS,
	LINEAR_GROWTH_LIMIT,
	measureGrowth,
	repeatedTo,
} from "../src/linear-time.js";
import {
	CREDENTIAL_PATTERNS,
	containsControlChar,
	createProviderRedactor,
	decodePercentFully,
	JWT_DETECTOR,
	JWT_PATTERN,
	PRIVATE_KEY_DETECTOR,
	PRIVATE_KEY_PATTERN,
	REDACTION_WINDOW,
	RedactionPatternError,
	redactionPattern,
	redactProviderText,
} from "../src/provider-redaction.js";

const MB = 1_000_000;
const repeated = (unit: string, length = MB) =>
	unit.repeat(Math.ceil(length / unit.length));

function timed(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

/** Each shared pattern by what it finds, in CREDENTIAL_PATTERNS' order. */
const PATTERN_NAMES = [
	"private key",
	"jwt",
	"bearer",
	"postgres url",
	"redis url",
	"mysql, mongodb or amqp url",
	"url credentials",
	"inline credentials",
	"secret key",
	"prefixed key",
] as const;
type PatternName = (typeof PATTERN_NAMES)[number];

function patternNamed(name: PatternName): RegExp {
	const pattern = CREDENTIAL_PATTERNS[PATTERN_NAMES.indexOf(name)];
	if (pattern === undefined) throw new Error(`no shared pattern ${name}`);
	return pattern;
}

type Adversary = {
	readonly name: string;
	/** The patterns a backtracking form of which it was built to defeat. */
	readonly targets: readonly PatternName[];
	readonly text: (length: number) => string;
};

// Each input makes a backtracking form of its target start again at every
// position and scan to the end, or scan back over what it already read.
const adversarial: readonly Adversary[] = [
	{ name: "-ey over and over", targets: ["jwt"], text: repeatedTo("-ey") },
	{
		name: "ey runs with no dot",
		targets: ["jwt"],
		text: repeatedTo("eyAAAAAAAAAA-"),
	},
	{
		name: "runs ending in a dot",
		targets: ["jwt"],
		text: repeatedTo("-eyAAAAAAAAAA."),
	},
	{
		name: "BEGIN markers",
		targets: ["private key"],
		text: repeatedTo("-----BEGIN PRIVATE KEY-----"),
	},
	{
		name: "END markers",
		targets: ["private key"],
		text: repeatedTo("-----END CERTIFICATE-----\n"),
	},
	{
		name: "long END labels after a BEGIN",
		targets: ["private key"],
		text: repeatedTo(
			`-----END ${"A ".repeat(500)}`,
			"-----BEGIN PRIVATE KEY-----\n",
		),
	},
	{
		name: "Bearer and a tab",
		targets: ["bearer"],
		text: repeatedTo("Bearer\t"),
	},
	{
		name: "Bearer and spaces to the end",
		targets: ["bearer"],
		text: repeatedTo(" ", "Bearer"),
	},
	{
		name: "connection-string schemes",
		targets: ["postgres url", "redis url", "mysql, mongodb or amqp url"],
		text: repeatedTo("postgres:/rediss:/mysql:/mongodb+srv:/"),
	},
	{
		name: "a scheme run",
		targets: ["url credentials"],
		text: repeatedTo("a."),
	},
	{
		name: ":// over and over",
		targets: ["url credentials", "inline credentials"],
		text: repeatedTo("a://"),
	},
	{
		name: "user and no @",
		targets: ["url credentials"],
		text: repeatedTo("a://b:"),
	},
	{
		name: "one long user",
		targets: ["url credentials"],
		text: (length) => `a://${"b".repeat(length / 2)}:${"c".repeat(length / 2)}`,
	},
	{ name: "//a", targets: ["inline credentials"], text: repeatedTo("//a") },
	{ name: "//a:a", targets: ["inline credentials"], text: repeatedTo("//a:a") },
	{ name: "one name run", targets: ["secret key"], text: repeatedTo("a") },
	{
		name: "names with no separator",
		targets: ["secret key"],
		text: repeatedTo("token"),
	},
	{
		name: "a name and spaces",
		targets: ["secret key"],
		text: repeatedTo(" ", "password"),
	},
	{
		name: "a separator and spaces",
		targets: ["secret key"],
		text: repeatedTo(" ", "password="),
	},
	{ name: "quotes", targets: ["secret key"], text: repeatedTo('"token"*:"') },
	{
		name: "-sk- over and over",
		targets: ["prefixed key"],
		text: repeatedTo("-sk-"),
	},
	{
		name: "a mix, with whitespace",
		targets: [],
		text: repeatedTo(
			"-ey-ey eyAAAAAAAAAAAA.eyBBBBBBBBBBBB -----BEGIN RSA PRIVATE KEY-----\n-----BEGIN PRIVATE KEY----- Bearer api_key= code= sk- a://b: //c:d \t\r\n",
		),
	},
];

function expectLinear(
	run: (text: string) => void,
	text: (length: number) => string,
	what: string,
): void {
	const growth = measureGrowth(run, text);
	expect(grewLinearly(growth), `${what}: ${JSON.stringify(growth)}`).toBe(true);
}

describe("every pattern on a hostile text", () => {
	const searchedWhole = (text: string) => {
		redactProviderText(text, 8 * MB);
	};

	it.each(
		adversarial.map((entry) => [entry.name, entry] as const),
	)("%s: searched whole, the cost grows linearly", (_case, entry) => {
		expectLinear(searchedWhole, entry.text, entry.name);
		// A megabyte, searched whole, still returns: only a hang trips this.
		const megabyte = entry.text(MB);
		expect(megabyte.length).toBeGreaterThanOrEqual(MB);
		expect(timed(() => searchedWhole(megabyte))).toBeLessThan(HANG_BACKSTOP_MS);
	});

	it.each(
		adversarial.map((entry) => [entry.name, entry] as const),
	)("%s: by default, the window bounds the output", (_case, entry) => {
		// The window only ever shortens what is searched whole above.
		expect(redactProviderText(entry.text(MB)).length).toBeLessThanOrEqual(257);
	});

	it("every shared pattern has an input built against it", () => {
		expect(CREDENTIAL_PATTERNS).toHaveLength(PATTERN_NAMES.length);
		expect(patternNamed("private key")).toBe(PRIVATE_KEY_PATTERN);
		expect(patternNamed("jwt")).toBe(JWT_PATTERN);
		const targeted = new Set(adversarial.flatMap((entry) => entry.targets));
		expect([...PATTERN_NAMES].filter((name) => !targeted.has(name))).toEqual(
			[],
		);
	});

	it.each(
		adversarial.flatMap((entry) =>
			entry.targets.map((target) => [target, entry.name, entry] as const),
		),
	)("the %s pattern alone grows linearly on %s", (target, _case, entry) => {
		const pattern = patternNamed(target);
		expectLinear(
			(text) => {
				text.replace(pattern, "[redacted]");
			},
			entry.text,
			`${target} on ${entry.name}`,
		);
	});

	it.each([
		[
			"the JWT detector",
			JWT_DETECTOR,
			["-ey over and over", "ey runs with no dot", "runs ending in a dot"],
		],
		[
			"the private-key detector",
			PRIVATE_KEY_DETECTOR,
			["BEGIN markers", "long END labels after a BEGIN"],
		],
	] as const)("%s grows linearly", (_case, detector, inputs) => {
		for (const entry of adversarial.filter((each) =>
			inputs.includes(each.name),
		)) {
			expectLinear(
				(text) => {
					detector.test(text);
				},
				entry.text,
				entry.name,
			);
		}
	});

	it("percent-decoding nested %25 grows linearly", () => {
		// One layer of `%25` per pass for the old decoder: `%252525…41`.
		const nested = (length: number) => `%${"25".repeat(length / 2)}41`;
		expectLinear(
			(text) => {
				decodePercentFully(text);
			},
			nested,
			"decodePercentFully",
		);
		const redact = createProviderRedactor({ decodePercent: true });
		expectLinear(
			(text) => {
				redact(text);
			},
			nested,
			"a decoding redactor",
		);
	});

	// The measure has to tell the two apart, or the tests above prove nothing:
	// the patterns and the decoder they replaced must fail it.
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
	] as const)("%s fails the measure", (_case, pattern, text) => {
		const growth = measureGrowth((each) => {
			each.replace(pattern, "x");
		}, text);
		expect(growth.ratio, JSON.stringify(growth)).toBeGreaterThanOrEqual(
			LINEAR_GROWTH_LIMIT,
		);
	});

	it("the old decoder, again until nothing changes, fails the measure", () => {
		const growth = measureGrowth(
			(text) => {
				decodeByPasses(text);
			},
			(length) => `%${"25".repeat(length / 2)}41`,
		);
		expect(growth.ratio, JSON.stringify(growth)).toBeGreaterThanOrEqual(
			LINEAR_GROWTH_LIMIT,
		);
	});
});

// The old way: decode the whole text again until it stops changing.
function decodeByPasses(text: string): string {
	let out = text;
	for (;;) {
		const decoded = out.replace(/%[a-f0-9]{2}/giu, (encoded) =>
			String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
		);
		if (decoded === out) return out;
		out = decoded;
	}
}

describe("redactProviderText", () => {
	it("redacts each shared shape", () => {
		const cases: readonly (readonly [string, string])[] = [
			[
				"key -----BEGIN EC PRIVATE KEY-----\nMIIBOg\n-----END EC PRIVATE KEY----- done",
				"key [redacted] done",
			],
			["auth Bearer abc.def ok", "auth [redacted] ok"],
			["dsn postgres://u:p@h/db ok", "dsn [redacted] ok"],
			["dsn prisma+postgres://h/?api_key=k ok", "dsn [redacted] ok"],
			["cache rediss://default:p@h:6379 ok", "cache [redacted] ok"],
			["mongo mongodb+srv://u:p@h ok", "mongo [redacted] ok"],
			["url https://user:pass@example.com/x ok", "url [redacted] ok"],
			["ref //user:pass@host/x", "ref [redacted]host/x"],
			["NETLIFY_AUTH_TOKEN=nfp_abc ok", "[redacted] ok"],
			["x-api-key: abc ok", "[redacted] ok"],
			["pgpassword=hunter2 ok", "[redacted] ok"],
			["requirepass s3cret ok", "requirepass s3cret ok"],
			["requirepass=s3cret ok", "[redacted] ok"],
			['body "token": "abc" ok', 'body "[redacted] ok'],
			["cli **Token:** abc ok", "cli **[redacted] ok"],
			["key sk_live_abcdefgh ok", "key [redacted] ok"],
			["gh ghp_abcdefghijkl ok", "gh [redacted] ok"],
			["slack xoxb-123456789 ok", "slack [redacted] ok"],
		];
		for (const [text, expected] of cases)
			expect(redactProviderText(text)).toBe(expected);
	});

	it("still redacts a JWT that follows a space, a quote, an equals sign, a colon, or a hyphen", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K";
		for (const before of [" ", '"', "=", ":"]) {
			expect(redactProviderText(`x${before}${jwt}`)).toBe(
				`x${before}[redacted]`,
			);
		}
		// A word boundary inside a base64url run is only after a `-`; the run's
		// start goes with the JWT.
		expect(redactProviderText(`id x-${jwt} ok`)).toBe("id [redacted] ok");
	});

	it("redacts a private key whole across a foreign END marker inside it", () => {
		expect(
			redactProviderText(
				"key -----BEGIN PRIVATE KEY-----\npartOne\n-----END CERTIFICATE-----\npartTwo\n-----END PRIVATE KEY----- done",
			),
		).toBe("key [redacted] done");
	});

	it("redacts a private key whose END is missing to the end of the text", () => {
		expect(
			redactProviderText(
				"key -----BEGIN EC PRIVATE KEY-----\nMIIBOgIBAAJBAK and the rest",
			),
		).toBe("key [redacted]");
	});

	it("flattens control characters, so a text cannot forge a log record", () => {
		expect(redactProviderText("a\nb\u0000c\u007f")).toBe("a b c");
		expect(containsControlChar("a\u001bb")).toBe(true);
		expect(containsControlChar("plain")).toBe(false);
	});

	// Text the shapes shrink to almost nothing (a bearer token of 400
	// characters is ten once redacted), so the window's end reaches the output.
	const shrinking = (before: number) =>
		repeated(`Bearer ${"A".repeat(400)} `, before).slice(
			0,
			before - (before % 408),
		);

	it("leaves nothing of a private key the window cuts, BEGIN kept and END cut off", () => {
		const body = Array.from(
			{ length: 40 },
			(_, i) => `MIIK${String(i).padStart(4, "0")}${"q".repeat(56)}`,
		).join("\n");
		const text = `${shrinking(REDACTION_WINDOW - 100)}-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;

		const redacted = redactProviderText(text);

		expect(text.indexOf("-----BEGIN")).toBeLessThan(REDACTION_WINDOW);
		expect(text.indexOf("-----END")).toBeGreaterThan(REDACTION_WINDOW);
		expect(redacted).not.toContain("MIIK");
		expect(redacted).not.toContain("qqqq");
		expect(redacted).not.toContain("BEGIN");
		expect(redacted.endsWith("[redacted]…")).toBe(true);
	});

	it("leaves nothing of a JWT the window cuts", () => {
		const header = `eyJ${"h".repeat(40)}`;
		const payload = `eyJ${"p".repeat(4000)}`;
		const text = `${shrinking(REDACTION_WINDOW - 100)}token ${header}.${payload}.sigsigsigsigsig`;

		const redacted = redactProviderText(text);

		expect(text.indexOf(header)).toBeLessThan(REDACTION_WINDOW);
		expect(text.indexOf(".sig")).toBeGreaterThan(REDACTION_WINDOW);
		expect(redacted).not.toContain("eyJ");
		expect(redacted).not.toContain("hhhh");
		expect(redacted).not.toContain("pppp");
		expect(redacted.endsWith("token [redacted]")).toBe(true);
	});

	it.each([
		[180, 180],
		[256, 256],
	])("shows the redacted start of a long body with no whitespace, at maxLength %i", (maxLength, shown) => {
		const body = `{"error":{"message":"rejected:sk_live_abcdefghijklmnop"},"pad":"${"x".repeat(20_000)}"}`;

		const redacted = redactProviderText(body, maxLength);

		const start = '{"error":{"message":"rejected:[redacted]"},"pad":"';
		expect(redacted).toBe(`${(start + "x".repeat(shown)).slice(0, shown)}…`);
		expect(redacted).not.toContain("sk_live");
	});

	it("marks a text cut when it is longer than maxLength or than the window", () => {
		expect(redactProviderText("x".repeat(300))).toBe(`${"x".repeat(256)}…`);
		expect(redactProviderText("short")).toBe("short");
		const long = `head ${"word ".repeat(REDACTION_WINDOW)}`;
		expect(redactProviderText(long, 4).endsWith("…")).toBe(true);
	});
});

describe("a provider profile", () => {
	it("searches the provider's shapes before the shared ones but the private key", () => {
		// The shared secret-key shape would otherwise take `Token:**` and leave
		// a format the provider's shape knows whole.
		const redact = createProviderRedactor({
			patterns: [/\*\*\s*Token\s*:?\s*\*\*\s*\S+/giu],
		});
		expect(redact("cli **Token:** abc ok")).toBe("cli [redacted] ok");
	});

	it("adds the provider's shapes to the shared ones", () => {
		const redact = createProviderRedactor({
			patterns: [/\bnpg_[A-Za-z0-9_-]{4,}/giu],
		});
		expect(redact("pw npg_abcd Bearer x")).toBe("pw [redacted] [redacted]");
		expect(redactProviderText("pw npg_abcd")).toBe("pw npg_abcd");
	});

	it("keeps spans whole, even one a shape would read through", () => {
		const digest = `sha256:${"a".repeat(64)}`;
		const redact = createProviderRedactor({
			keep: /\bsha(?:256|512)[:-][0-9a-f]{32,128}\b/giu,
			patterns: [/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{40,}={0,2}\b/gu],
		});
		expect(
			redact(`pushed ${digest} and ${digest} with ${"Z".repeat(48)}`),
		).toBe(`pushed ${digest} and ${digest} with [redacted]`);
		// A text that carries the placeholder's delimiters cannot forge a slot.
		expect(redact(`x \uE0000\uE001 ${digest}`)).toBe(
			`x \uFFFD0\uFFFD ${digest}`,
		);
	});

	it("decodes percent-encoding fully before searching, when asked", () => {
		const redact = createProviderRedactor({ decodePercent: true });
		expect(redact("auth Bearer%2520abc")).toBe("auth [redacted]");
		expect(redactProviderText("auth Bearer%2520abc")).toBe(
			"auth Bearer%2520abc",
		);
	});

	it("collapses whitespace, when asked", () => {
		const redact = createProviderRedactor({ collapseWhitespace: true });
		expect(redact("a   b\n\n c")).toBe("a b c");
	});

	it("refuses a shape that would miss occurrences", () => {
		expect(() => createProviderRedactor({ patterns: [/x/u] })).toThrow(
			RedactionPatternError,
		);
		expect(() => redactionPattern(/x/gy)).toThrow(/sticky/u);
		expect(redactionPattern(/x/gu).global).toBe(true);
	});
});

describe("decodePercentFully", () => {
	it("decodes every layer", () => {
		expect(decodePercentFully("%252541%2F")).toBe("A/");
		expect(decodePercentFully("%%3341")).toBe("41");
		expect(decodePercentFully("no escapes")).toBe("no escapes");
	});

	it("gives the same text as decoding again until nothing changes", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom("%", "2", "5", "4", "1", "a", "F", "x", "3"), {
					maxLength: 40,
				}),
				(units) => {
					const text = units.join("");
					expect(decodePercentFully(text)).toBe(decodeByPasses(text));
				},
			),
			{ numRuns: 2000, seed: 20261108 },
		);
	});
});
