/**
 * The public redaction gate scans the whole rendered page, and three of its
 * rules backtracked on it: the credential-in-URL rule started at every letter
 * and read the scheme run to its end, and the internal-hostname and email
 * rules started at every word boundary inside a run (`a-a-a-…`, `a.a.a.…`).
 * Each now starts once per run, at the position the old rule matched first,
 * so it reports the same matches; these pin that against the old rules on
 * generated text, and that each rule's cost grows linearly.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
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
			["a", "B", "1", "+", ".", "-", ":", "/", "@", " ", "x"],
		],
		[
			"internal-hostname",
			["a", "B", "1", "-", ".", " ", "corp", "lan", "internal", "@"],
		],
		[
			"email-address",
			["a", "B", "1", "_", ".", "%", "+", "-", "@", " ", "com", "io"],
		],
	] as const)("%s reports exactly what the old rule did", (id, alphabet) => {
		for (const text of texts(alphabet, 20_000)) {
			expect(matches(rule(id), text), JSON.stringify(text)).toEqual(
				matches(OLD_RULES[id], text),
			);
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
