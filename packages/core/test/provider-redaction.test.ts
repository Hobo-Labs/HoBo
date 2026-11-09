/**
 * The shared provider redactor: every shape linear on 1 MB of a hostile text,
 * the window and its cut, the profile a provider extends it with, and the
 * one-pass percent-decoding.
 *
 * Ported from provider-vercel's hostile-text tests, where the shapes first
 * became linear: the JWT shape could start at every `ey` and run to the end
 * (100 kB of `-ey` took about ten seconds), and the private-key shape searched
 * from every BEGIN for an END that never came.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	CREDENTIAL_PATTERNS,
	containsControlChar,
	createProviderRedactor,
	decodePercentFully,
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
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

describe("every shape on 1 MB of a hostile text", () => {
	// One input per shape, built to make a backtracking form of it start again
	// at every position and scan to the end. The window is opened past the
	// whole megabyte (maxLength 2 MB), so the shapes run on all of it.
	const adversarial: readonly (readonly [string, string])[] = [
		["jwt: -ey over and over", repeated("-ey")],
		["jwt: ey runs with no dot", repeated("eyAAAAAAAAAA-")],
		["jwt: runs ending in a dot", repeated("-eyAAAAAAAAAA.")],
		["private key: BEGIN markers", repeated("-----BEGIN PRIVATE KEY-----")],
		["private key: END markers", repeated("-----END CERTIFICATE-----\n")],
		[
			"private key: long END labels after a BEGIN",
			`-----BEGIN PRIVATE KEY-----\n${repeated(`-----END ${"A ".repeat(500)}`)}`,
		],
		["bearer: Bearer and a tab", repeated("Bearer\t")],
		["bearer: Bearer and spaces to the end", `Bearer${" ".repeat(MB)}`],
		["connection strings", repeated("postgres:/rediss:/mysql:/")],
		["url credentials: a scheme run", repeated("a.")],
		["url credentials: :// over and over", repeated("a://")],
		["url credentials: user and no @", repeated("a://b:")],
		[
			"url credentials: one long user",
			`a://${"b".repeat(MB)}:${"c".repeat(MB)}`,
		],
		["inline credentials: //a", repeated("//a")],
		["inline credentials: //a:a", repeated("//a:a")],
		["secret key: one name run", repeated("a")],
		["secret key: names with no separator", repeated("token")],
		["secret key: a name and spaces", `password${" ".repeat(MB)}`],
		["secret key: a separator and spaces", `password=${" ".repeat(MB)}`],
		["secret key: quotes", repeated('"token"*:"')],
		["prefixed key: -sk- over and over", repeated("-sk-")],
		[
			"a mix, with whitespace",
			repeated(
				"-ey-ey eyAAAAAAAAAAAA.eyBBBBBBBBBBBB -----BEGIN RSA PRIVATE KEY-----\n-----BEGIN PRIVATE KEY----- Bearer api_key= code= sk- a://b: //c:d \t\r\n",
			),
		],
	];

	it.each(
		adversarial,
	)("%s is searched whole in well under a second", (_case, hostile) => {
		expect(hostile.length).toBeGreaterThanOrEqual(MB);
		const took = timed(() => redactProviderText(hostile, 2 * MB));
		expect(took).toBeLessThan(1000);
	});

	it.each(
		adversarial,
	)("%s costs no more than the window by default", (_case, hostile) => {
		let redacted = "";
		const took = timed(() => {
			redacted = redactProviderText(hostile);
		});
		expect(redacted.length).toBeLessThanOrEqual(257);
		expect(took).toBeLessThan(1000);
	});

	it("each shared shape alone stays linear on each input", () => {
		for (const pattern of CREDENTIAL_PATTERNS) {
			for (const [, hostile] of adversarial) {
				const took = timed(() => hostile.replace(pattern, "[redacted]"));
				expect(
					took,
					`${pattern.source} on ${hostile.slice(0, 20)}`,
				).toBeLessThan(1000);
			}
		}
	});

	it("the detectors stay linear too", () => {
		for (const [, hostile] of adversarial) {
			expect(timed(() => JWT_DETECTOR.test(hostile))).toBeLessThan(1000);
			expect(timed(() => PRIVATE_KEY_DETECTOR.test(hostile))).toBeLessThan(
				1000,
			);
		}
	});

	it("percent-decoding a megabyte of nested %25 is one pass", () => {
		// One layer of `%25` per pass for the old decoder: `%252525…41`.
		const nested = `%${"25".repeat(MB / 2)}41`;
		expect(timed(() => decodePercentFully(nested))).toBeLessThan(1000);
		expect(
			timed(() => createProviderRedactor({ decodePercent: true })(nested)),
		).toBeLessThan(1000);
	});
});

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
