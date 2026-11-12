/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `redaction-linear.test.ts`.
 */
import {
	assertSweepLinear,
	patternSpec,
	type SweepSpec,
} from "@hobo/redaction-test-harness/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
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
	// At full volume: the fast tier runs 20k texts of each.
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
		{ timeout: 600_000 },
		(id, alphabet, count) => {
			for (const text of texts(alphabet, count)) {
				expect(matches(rule(id), text), JSON.stringify(text)).toEqual(
					matches(OLD_RULES[id], text),
				);
			}
		},
	);

	it("the hostname rule overlaps every hostname the old rule found", {
		timeout: 600_000,
	}, () => {
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

	// The structural inputs a review found the hostname and email rules
	// quadratic on; runs of each class they read, alone and in pairs, are the
	// sweep's below.
	it.each([
		["internal-hostname", "a.corp-a.corp-…", repeatedTo("a.corp-")],
		["email-address", "a@b.io.a@b.io.…", repeatedTo("a@b.io.")],
		["email-address", "@b.io.b.io.b.io…", repeatedTo("b.io.", "@")],
		[
			"email-address",
			"@ and a long tld run",
			repeatedTo(`${"a".repeat(60)}.`, "@"),
		],
	] as const)(
		"%s grows linearly on %s",
		{ timeout: 600_000 },
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

	it.each(
		REDACTION_RULES.map((each) => each.id),
	)("%s grows linearly on the whole sweep", { timeout: 600_000 }, (id) => {
		const pattern = rule(id);
		const spec = SWEEPS.get(id);
		if (spec === undefined) throw new Error(`no sweep for ${id}`);
		assertSweepLinear(
			(text) => {
				text.replace(new RegExp(pattern.source, pattern.flags), "");
			},
			patternSpec(pattern, spec),
		);
	});

	it.each([
		["a.a-", repeatedTo("a.a-")],
		["digits", repeatedTo("1")],
		["1.-%+", repeatedTo("1.-%+")],
	] as const)(
		"the whole scan grows linearly on %s",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				scanRenderedOutput(text);
			}, input);
		},
	);
});
