import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	containsControlChar,
	createProviderRedactor,
	decodePercentFully,
	REDACTION_WINDOW,
	RedactionPatternError,
	redactionPattern,
	redactMatches,
	redactProviderText,
	SIGNED_JWT_PATTERN,
} from "../src/provider-redaction.js";
import { decodeByPasses, MB } from "./adversarial.js";

const repeated = (unit: string, length = MB) =>
	unit.repeat(Math.ceil(length / unit.length));

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
		for (const before of [" ", '"', "=", ":", "-"]) {
			expect(redactProviderText(`x${before}${jwt}`)).toBe(
				`x${before}[redacted]`,
			);
		}
		// A hyphen inside a word is a boundary, as the old `\bey` had it, and
		// the word before it is kept (#1773 9d3fe8c2).
		expect(redactProviderText(`token-${jwt} end`)).toBe("token-[redacted] end");
		expect(redactProviderText(`id x-${jwt} ok`)).toBe("id x-[redacted] ok");
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

	it("redacts an Authorization header in any scheme, and Basic and Token credentials", () => {
		for (const [text, expected] of [
			["Authorization: Basic dXNlcjpwYXNz ok", "[redacted] ok"],
			["authorization=token abc123 ok", "[redacted] ok"],
			['{"Authorization": "Digest x=1"} ok', '{"[redacted] ok'],
			["sent Basic dXNlcjpwYXNzd29yZA== ok", "sent [redacted] ok"],
			["sent Token 0123456789abcdef ok", "sent [redacted] ok"],
			["a basic plan and a token budget", "a basic plan and a token budget"],
		] as const)
			expect(redactProviderText(text)).toBe(expected);
	});

	it("reads a credential on through a control character inside it", () => {
		for (const text of [
			"Bearer abcd\u0007SECRCTL3 ok",
			"token=abcd\u0000SECRCTL2tail ok",
		])
			expect(redactProviderText(text)).not.toContain("SECRCTL");
	});

	it("keeps a locator, which is a reference, and redacts a token beside it", () => {
		for (const locator of [
			"hobo-token://camp/vercel",
			"secret://camp/aws-deploy",
			"hobo-secret://camp/db",
		]) {
			const redacted = redactProviderText(
				`credentialRef ${locator} and token=abc123secret`,
			);
			expect(redacted).toBe(`credentialRef ${locator} and [redacted]`);
		}
		expect(redactProviderText("token: secret://camp/x")).toBe(
			"token: secret://camp/x",
		);
	});

	it("keeps only a clean locator: one a control character runs on through is redacted", () => {
		expect(redactProviderText("ref hobo-token://camp/x ok")).toBe(
			"ref hobo-token://camp/x ok",
		);
		for (const text of [
			"ref hobo-token://camp/x\u001bSECRLOC1 ok",
			"token=hobo-token://camp/x\u0000SECRLOC1 ok",
			`token=hobo-token://${"a".repeat(300)}SECRLOC1 ok`,
		]) {
			expect(redactProviderText(text, 10_000)).not.toContain("SECRLOC1");
		}
	});

	it("finds a credential whose name another match took as its value", () => {
		for (const text of [
			'"token": "\'npg_password: SECRVAL1 ok',
			"api_key=password: SECRVAL1 ok",
			"x code=password: SECRVAL1 ok",
		]) {
			expect(redactProviderText(text, 10_000)).not.toContain("SECRVAL1");
		}
	});

	it.each([
		[
			"a `-----BEGIN` inside the body",
			"-----BEGIN PRIVATE KEY-----\n-----BEGINx\nSECRETBODY1\nBearer -----END PRIVATE KEY-----\n",
		],
		[
			"a BEGIN line glued after a control character",
			"-----BEGIN PRIVATE KEY-----*\u001b-----BEGIN SECRETBODY1 Bearer -----END PRIVATE KEY-----",
		],
	])("runs a key whose END line another shape took past %s, to the next BEGIN line", (_case, text) => {
		expect(redactProviderText(text, 10_000)).toBe("[redacted]");
	});

	it("redacts a key a JWT made a BEGIN line of, from its first `-----BEGIN`", () => {
		// Taken first, the JWT took the second line's `-----BEGIN`, and the
		// first `-----BEGINx` then read as a BEGIN line.
		const text =
			"-----BEGINx\nSECRETBODY1\u001beyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sigsigsig-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
		expect(redactProviderText(text, 10_000)).toBe("[redacted]");
	});

	it.each([
		["ſ", "ſeyAiYWxnIjoiSFMSECR.eyAic3ViIjoiU0VDUiJ9.sigSECRsig"],
		["ſ", "ſeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.SECRB2JWT"],
		["ſ", "ſghp_SECRB2GHPabcdefghijklmnop"],
		["\u212a", "\u212ask_live_SECRB2SKabcdefghijkl"],
		["ſ", "ſBearer SECRB2BEARER"],
	])("finds a credential after %s, which `i` with `u` folds to an ASCII letter", (letter, text) => {
		// The letter is part of the key's run now, so a prefixed key takes it
		// with it; a JWT keeps it as the run's lead.
		const out = redactProviderText(`x ${text} y`, 10_000);
		expect(out).not.toMatch(/SECR|ghp_|sk_live|Bearer/u);
		expect([`x ${letter}[redacted] y`, "x [redacted] y"]).toContain(out);
	});

	it("reads a credential on through ſ and K, as the `iu` copies did", () => {
		for (const key of [
			"sk_live_\u212aSECRB2SKabcdefghijkl",
			"ghp_abcdefghijklmnopqrstuvwxyzſSECRB2",
		])
			expect(redactProviderText(`x ${key} y`, 10_000)).toBe("x [redacted] y");
		expect(redactProviderText("x SECRB2NAME\u212apwd=hunter2 y")).toBe(
			"x [redacted] y",
		);
	});

	it("takes what is glued to a private key's END line with it", () => {
		const key =
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----npg_SECRPEM1";
		expect(redactProviderText(`before ${key} after`)).toBe(
			"before [redacted] after",
		);
	});

	it("redacts every match of every pattern as one marker per run of them", () => {
		const opaque = redactionPattern(/[A-Za-z0-9_-]{20,}/gu);
		const url = redactionPattern(/postgres:\/\/\S+/gu);
		// The url match ends a run the long-run rule needs whole: both are kept.
		expect(
			redactMatches("x SECRQcY0c2SQ0123postgres://u:p@h y", [url, opaque]),
		).toBe("x [redacted] y");
		expect(redactMatches("a b", [opaque])).toBe("a b");
	});

	it("tells a Basic or Token credential from the word after it in prose", () => {
		for (const prose of [
			"Token required for this call",
			"Basic authentication failed",
			"Token Authentication is off",
			"Token expired at noon",
			"Basic credentials missing",
		])
			expect(redactProviderText(prose)).toBe(prose);
		for (const credential of [
			"abcdefgh1",
			"dXNlcjpwYXNz",
			"ABCDEFGHIJ",
			"abc.defgh",
		])
			expect(redactProviderText(`sent Token ${credential} ok`)).toBe(
				"sent [redacted] ok",
			);
	});

	it("takes a JWT's header and payload minimums from the copies it replaced", () => {
		expect(redactProviderText("my-eyewear-store.myshopify.com")).toBe(
			"my-eyewear-store.myshopify.com",
		);
		// ten and ten after `ey`, or eight, eight and eight after `eyJ`.
		expect(redactProviderText("t eyAAAAAAAAAA.BBBBBBBBBB.c ok")).toBe(
			"t [redacted] ok",
		);
		expect(redactProviderText("t eyJAAAAAAAA.BBBBBBBB.CCCCCCCC ok")).toBe(
			"t [redacted] ok",
		);
	});

	it("takes a prefixed key's whole run, not only from its prefix", () => {
		const run = `${"A".repeat(30)}SECROPQ1-sk_${"B".repeat(20)}`;
		expect(redactProviderText(`x ${run} y`)).toBe("x [redacted] y");
	});

	it("finds a credential a control character was meant to hide", () => {
		for (const text of [
			"PASSWORD\u0000=hunter2",
			"Bearer\u0001abc123",
			"api_key\u001b=abc123",
		])
			expect(redactProviderText(`x ${text} y`)).toBe("x [redacted] y");
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

	it("bounds the signed JWT pattern to its three segments", () => {
		const jwt =
			"eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLXZhbHVl";
		const find = (text: string) =>
			[...text.matchAll(SIGNED_JWT_PATTERN)].map((match) => match[0]);
		expect(find(`{"jwt":"${jwt}","next":1}`)).toEqual([jwt]);
		expect(find(`x-${jwt}`)).toEqual([`x-${jwt}`]);
		expect(find("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.")).toEqual([]);
	});

	it("redacts a JWT whole, whichever group a long-run rule is in", () => {
		const header = `eyJ${"h".repeat(53)}`;
		const payload = "eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJyb290In0";
		const signature = "s".repeat(48);
		const jwt = `${header}.${payload}.${signature}`;
		const opaque = /[A-Za-z0-9_-]{40,}/gu;
		// Searched in turn over a text being rewritten, the rule run first split
		// it and the payload survived; every shape now searches the same text.
		for (const profile of [{ fallbacks: [opaque] }, { patterns: [opaque] }]) {
			expect(createProviderRedactor(profile)(`token ${jwt} ok`)).toBe(
				"token [redacted] ok",
			);
		}
	});

	it("leaves no shape short of the text another one matched", () => {
		const redact = createProviderRedactor({
			patterns: [/\bcode\s*[=:]\s*[A-Za-z0-9-]{8,}/giu],
			fallbacks: [/[A-Za-z0-9/+=_-]{20,}/gu],
		});
		// `code` takes `password` from the secret-key shape, which still sees it.
		expect(redact("x code=password: .-hunter2hunter2 y")).toBe(
			"x [redacted] y",
		);
		// The postgres URL takes the end of a run the long-run rule needs whole.
		expect(redact("x SECRQcY0c2SQ0123postgres://u:p@h y")).toBe(
			"x [redacted] y",
		);
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
		// The text between kept spans is searched on its own, so a run that
		// would be long enough with the digest in it is not.
		const before = `${"Z".repeat(20)}-`;
		expect(redact(`${before}${digest}`)).toBe(`${before}${digest}`);
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
