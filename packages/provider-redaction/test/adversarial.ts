/**
 * The fixed hostile inputs every review round found a quadratic search on,
 * named by what they defeat: the fast tier screens each one
 * (`provider-redaction.test.ts`), and the deep tier measures their growth and
 * sweeps every class around them (`hostile-text.deep.test.ts`).
 */
import { repeatedTo } from "@hobo/redaction-test-harness/linear-time";
import { CREDENTIAL_PATTERNS } from "../src/provider-redaction.js";

export const MB = 1_000_000;

/** Each shared pattern by what it finds, in CREDENTIAL_PATTERNS' order. */
export const PATTERN_NAMES = [
	"private key",
	"jwt",
	"json jwt",
	"bearer",
	"authorization header",
	"basic or token",
	"postgres url",
	"redis url",
	"mysql, mongodb or amqp url",
	"url credentials",
	"inline credentials",
	"secret key",
	"prefixed key",
] as const;
export type PatternName = (typeof PATTERN_NAMES)[number];

export function patternNamed(name: PatternName): RegExp {
	const pattern = CREDENTIAL_PATTERNS[PATTERN_NAMES.indexOf(name)];
	if (pattern === undefined) throw new Error(`no shared pattern ${name}`);
	return pattern;
}

export type Adversary = {
	readonly name: string;
	/** The patterns a backtracking form of which it was built to defeat. */
	readonly targets: readonly PatternName[];
	readonly text: (length: number) => string;
};

// Each input makes a backtracking form of its target start again at every
// position and scan to the end, or scan back over what it already read.
export const adversarial: readonly Adversary[] = [
	{ name: "-ey over and over", targets: ["jwt"], text: repeatedTo("-ey") },
	{
		name: "-eyJ over and over",
		targets: ["json jwt"],
		text: repeatedTo("-eyJ"),
	},
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
		name: "Authorization: over and over",
		targets: ["authorization header"],
		text: repeatedTo("Authorization: "),
	},
	{
		name: "authorization= and a scheme with nothing after it",
		targets: ["authorization header"],
		text: repeatedTo("authorization=basic "),
	},
	{
		name: "Basic and short credentials",
		targets: ["basic or token"],
		text: repeatedTo("Basic abcdefg Token abcdefg "),
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
	// Round 3, B-1 in 0462fa6c: a key, a long run after its END line, and an
	// END after the run, which the key shape then read again from every place
	// it could give a character back.
	{
		name: "a key, a run and an END after it",
		targets: ["private key"],
		text: (length) =>
			`-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----${"a".repeat(length)} -----END`,
	},
	// Rounds 2 and 3: a value that chained on to the end and was read again
	// from each run after it.
	...[
		"token: ",
		"a: token: ",
		"**Token**: ",
		"api_key=password: ",
		"Bearer ",
		"authorization: bearer ",
		"-----BEGIN PRIVATE KEY----- ",
	].map(
		(unit): Adversary => ({
			name: `${JSON.stringify(unit)} over and over`,
			targets: ["secret key", "bearer", "authorization header"],
			text: repeatedTo(unit),
		}),
	),
	// Round 2: two optional quantifiers reading a run of spaces two ways.
	{
		name: "authorization, a quote and spaces",
		targets: ["authorization header"],
		text: (length) => `authorization"${" ".repeat(length)}`,
	},
	// Round 5: classes that held ſ and K under lookbehinds that did not, so
	// every position in a run of them started a match.
	{
		name: "ſ over and over",
		targets: ["jwt", "url credentials", "secret key", "prefixed key"],
		text: repeatedTo("\u017F"),
	},
	{
		name: "K over and over",
		targets: ["jwt", "url credentials", "secret key", "prefixed key"],
		text: repeatedTo("\u212A"),
	},
	{
		name: "passKword over and over",
		targets: ["secret key"],
		text: repeatedTo("pass\u212Aword"),
	},
	{
		name: "ſk- over and over",
		targets: ["prefixed key"],
		text: repeatedTo("\u017Fk-"),
	},
	{
		name: "BEGIN lines a JWT runs through",
		targets: ["private key"],
		text: repeatedTo(
			`-----BEGIN eyJhbGciOiJIUzI1NiJ9-x.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXNpZw `,
		),
	},
	{
		name: "made BEGIN lines around keys",
		targets: ["private key"],
		text: repeatedTo(
			"-----BEGIN a -----BEGIN PRIVATE KEY-----\nb\n-----END PRIVATE KEY----- PRIVATE KEY-----\n",
		),
	},
	{
		name: "a mix, with whitespace",
		targets: [],
		text: repeatedTo(
			"-ey-ey eyAAAAAAAAAAAA.eyBBBBBBBBBBBB -----BEGIN RSA PRIVATE KEY-----\n-----BEGIN PRIVATE KEY----- Bearer api_key= code= sk- a://b: //c:d \t\r\n",
		),
	},
];

// The old way: decode the whole text again until it stops changing.
export function decodeByPasses(text: string): string {
	let out = text;
	for (;;) {
		const decoded = out.replace(/%[a-f0-9]{2}/giu, (encoded) =>
			String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
		);
		if (decoded === out) return out;
		out = decoded;
	}
}
