/**
 * The public redaction gate scans the whole rendered page, and three of its
 * rules backtracked on it: the credential-in-URL rule started at every letter
 * and read the scheme run to its end, and the internal-hostname and email
 * rules started at every word boundary inside a run (`a-a-a-…`, `a.a.a.…`).
 * Each now starts once per run, at the position the old rule matched first:
 * the credential and email rules report the same matches as the old ones, and
 * the hostname rule the same and more (it also starts after `_`). These pin
 * that against the old rules on generated text, and that every rule's cost
 * grows linearly on runs of every character class and pair of them.
 */
import {
	assertSweepLinear,
	patternFragments,
	type SweepSpec,
} from "@hobo/provider-redaction/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/provider-redaction/linear-time";
import { describe, expect, it } from "vitest";

import { REDACTION_RULES, scanRenderedOutput } from "../src/index.js";

const OLD_RULES = {
	"credential-in-url": /[a-z][a-z0-9+.-]*:\/\/[^/\s:@<>&"']+:[^/\s@<>&"']+@/gi,
	"internal-hostname":
		/\b[a-z0-9][a-z0-9-]*\.(?:internal|corp|lan|intranet)\b/gi,
	"email-address": /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
};

function rule(id: string): RegExp {
	const found = REDACTION_RULES.find((each) => each.id === id);
	if (found === undefined) throw new Error(`no redaction rule ${id}`);
	return found.pattern;
}

function matches(pattern: RegExp, text: string): readonly string[] {
	return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map(
		(match) => `${match.index}:${match[0]}`,
	);
}

// A small deterministic generator, so a failure names a text that replays.
function* texts(alphabet: readonly string[], count: number) {
	let seed = 20261109;
	for (let index = 0; index < count; index++) {
		let text = "";
		const length = 1 + (index % 40);
		for (let char = 0; char < length; char++) {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			text += alphabet[seed % alphabet.length];
		}
		yield text;
	}
}

describe("the public redaction gate's linear rules", () => {
	it.each([
		[
			"credential-in-url",
			["a", "B", "1", "+", ".", "-", ":", "/", "@", " ", "x", "_", "%", "u:p@"],
			50_000,
		],
		[
			"email-address",
			[
				"a",
				"B",
				"1",
				"_",
				".",
				"%",
				"+",
				"-",
				"@",
				" ",
				"com",
				"io",
				"x@b.io.",
				"ann@x.io-",
				"@b.co.%",
			],
			150_000,
		],
	] as const)(
		"%s reports exactly what the old rule did",
		{ timeout: 30_000 },
		(id, alphabet, count) => {
			for (const text of texts(alphabet, count)) {
				expect(matches(rule(id), text), JSON.stringify(text)).toEqual(
					matches(OLD_RULES[id], text),
				);
			}
		},
	);

	it.each([
		["ann@x.io-bob@y.io", ["0:ann@x.io", "8:-bob@y.io"]],
		["a@b.co.%@b.co", ["0:a@b.co", "6:.%@b.co"]],
		["__a@b.io", ["0:__a@b.io"]],
		["._a@b.io", ["1:_a@b.io"]],
	] as const)("the email rule finds %s as the old one did", (text, found) => {
		expect(matches(rule("email-address"), text)).toEqual(found);
		expect(matches(OLD_RULES["email-address"], text)).toEqual(found);
	});

	// The gate refuses a page on any match and rewrites nothing, so what has to
	// hold is that it refuses wherever the old rule did: every old match
	// overlaps a new one (in `_B-.corp.corp` the new rule takes `B-.corp`
	// where the old, which could not start after `_`, took `corp.corp`).
	it("the hostname rule overlaps every hostname the old rule found", () => {
		const alphabet = [
			"a",
			"B",
			"1",
			"-",
			".",
			" ",
			"_",
			"corp",
			"lan",
			".corp",
			"@",
		];
		for (const text of texts(alphabet, 50_000)) {
			const spans = [
				...text.matchAll(new RegExp(rule("internal-hostname").source, "gi")),
			].map((match) => [match.index, match.index + match[0].length] as const);
			for (const old of text.matchAll(OLD_RULES["internal-hostname"])) {
				const end = old.index + old[0].length;
				expect(
					spans.some(([from, to]) => from < end && old.index < to),
					JSON.stringify(text),
				).toBe(true);
			}
		}
	});

	it("an internal hostname after an underscore is now found from the run's start", () => {
		// The old rule could not start after `_` (no word boundary) and began
		// after the next `-`; the new one takes the whole hostname.
		expect(matches(rule("internal-hostname"), "x_db-1.corp")).toEqual([
			"2:db-1.corp",
		]);
		expect(matches(OLD_RULES["internal-hostname"], "x_db-1.corp")).toEqual([
			"5:1.corp",
		]);
	});

	// Every rule on runs it could backtrack in, starting with each kind of
	// character it reads: a letter, a digit, `.`, `-`, `%` and `+`.
	const runs = [
		["letters", repeatedTo("a")],
		["digits", repeatedTo("1")],
		["dots", repeatedTo(".")],
		["hyphens", repeatedTo("-")],
		["percent signs", repeatedTo("%")],
		["plus signs", repeatedTo("+")],
		["a scheme run", repeatedTo("a.")],
		["a-a-a-…", repeatedTo("a-")],
		["1.1.1.…", repeatedTo("1.")],
		["%a%a%a…", repeatedTo("%a")],
	] as const;
	const linearRules = [
		"credential-in-url",
		"internal-hostname",
		"email-address",
	] as const;
	it.each([
		["internal-hostname", "a.corp-a.corp-…", repeatedTo("a.corp-")],
		["email-address", "a@b.io.a@b.io.…", repeatedTo("a@b.io.")],
		["email-address", "@b.io.b.io.b.io…", repeatedTo("b.io.", "@")],
		[
			"email-address",
			"@ and a long tld run",
			repeatedTo(`${"a".repeat(60)}.`, "@"),
		],
		...linearRules.flatMap((id) =>
			runs.map(([name, text]) => [id, name, text] as const),
		),
	] as const)(
		"%s grows linearly on %s",
		{ timeout: 30_000 },
		(id, _case, input) => {
			const pattern = rule(id);
			assertGrowsLinearly((text) => {
				text.replace(new RegExp(pattern.source, pattern.flags), "");
			}, input);
		},
	);

	// Every rule on runs of each class it reads and the separators, alone,
	// in pairs and after its own words, so no class is left out by hand.
	const SWEEPS = new Map<string, SweepSpec>([
		["credential-in-url", { alphabet: "aZ9", words: ["http://", "u:p@"] }],
		["aws-access-key", { alphabet: "AZ9", words: ["AKIA"] }],
		[
			"private-key-block",
			{
				alphabet: "aZ9",
				words: ["-----BEGIN ", "PRIVATE KEY-----"],
			},
		],
		["private-ipv4", { alphabet: "9", words: ["10.", "192.168."] }],
		[
			"loopback-url",
			{
				alphabet: "aZ9",
				words: ["http://localhost", "127.0.0.1"],
			},
		],
		["internal-hostname", { alphabet: "aZ9", words: [".corp", ".internal"] }],
		["email-address", { alphabet: "aZ9", words: ["@b.io", "a@b.io"] }],
		["secret-assignment", { alphabet: "aZ9", words: ["token=", "password:"] }],
	]);

	it("every rule has a sweep", () => {
		expect([...SWEEPS.keys()].sort()).toEqual(
			REDACTION_RULES.map((each) => each.id).sort(),
		);
	});

	it.each(
		REDACTION_RULES.map((each) => each.id),
	)("%s grows linearly on the whole sweep", { timeout: 60_000 }, (id) => {
		const pattern = rule(id);
		const spec = SWEEPS.get(id);
		if (spec === undefined) throw new Error(`no sweep for ${id}`);
		assertSweepLinear(
			(text) => {
				text.replace(new RegExp(pattern.source, pattern.flags), "");
			},
			{ ...spec, fragments: patternFragments(pattern) },
		);
	});

	it.each([
		["a.a-", repeatedTo("a.a-")],
		["digits", repeatedTo("1")],
		["1.-%+", repeatedTo("1.-%+")],
	] as const)(
		"the whole scan grows linearly on %s",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				scanRenderedOutput(text);
			}, input);
		},
	);
});
