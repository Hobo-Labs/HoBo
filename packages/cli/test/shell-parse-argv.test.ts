/**
 * The CLI argument parser.
 *
 * The property that shapes this whole file is that **most flags are scoped to a
 * verb**. `--token` means something to `claim` and nothing to `up`; `--demo`
 * belongs to `serve` alone. The parser enforces that at parse time rather than
 * letting each command ignore what it does not understand, and the difference
 * matters: a typo'd `hobo up --token abc` that parsed silently would deploy
 * *without* the thing the user thought they were passing, and the deploy would
 * succeed. Refusing the flag is what turns a silent wrong action into an error.
 *
 * That scoping is also order-dependent in a way worth pinning. The verb is read
 * from the argv stream as it goes, so a verb-scoped flag written *before* its
 * verb is rejected — at the point the flag is seen, the parser does not yet know
 * which verb it belongs to.
 *
 * The other rule here is that a value flag consumes exactly the next token, and
 * refuses one that looks like another flag. `hobo up --to --json` almost
 * certainly means the user forgot a revision, and binding `--json` as the
 * revision would deploy something named `--json`.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { UsageError } from "../src/shell/errors.js";
import {
	assertKnownVerb,
	parseArgv,
	unknownVerbMessage,
} from "../src/shell/parse.js";

/** Parse with a fixed cwd so path resolution is predictable. */
function parse(argv: readonly string[]) {
	return parseArgv(argv, { cwd: "/work" });
}

describe("verb and positional arguments", () => {
	it("reads the first bare token as the verb", () => {
		expect(parse(["up"]).verb).toBe("up");
	});

	it("reports no verb for an empty argv", () => {
		// `hobo` alone is a legitimate invocation — it prints help. Inventing a
		// default verb would run something the user did not ask for.
		expect(parse([]).verb).toBeNull();
		expect(parse([]).args).toEqual([]);
	});

	it("collects later bare tokens as arguments", () => {
		const request = parse(["yard", "init", "local"]);
		expect(request.verb).toBe("yard");
		expect(request.args).toEqual(["init", "local"]);
	});

	it("keeps argument order", () => {
		// Subcommands are positional. Reordering would turn `yard init local`
		// into `yard local init`, which addresses a different thing.
		expect(parse(["yard", "a", "b", "c"]).args).toEqual(["a", "b", "c"]);
	});

	it("stops interpreting flags after a bare double dash", () => {
		// The escape hatch: everything after `--` is the user's, not ours. A
		// parser that kept interpreting would reject a payload that legitimately
		// contains `--json`.
		const request = parse(["dev", "--", "--json", "--not-a-flag", "value"]);
		expect(request.args).toEqual(["--json", "--not-a-flag", "value"]);
		expect(request.flags.json).toBe(false);
	});

	it("treats a double dash with nothing after it as an empty tail", () => {
		expect(parse(["dev", "--"]).args).toEqual([]);
	});
});

describe("global flags", () => {
	it("parses the boolean globals", () => {
		const flags = parse(["up", "--json", "--verbose", "-q", "--force"]).flags;
		expect(flags.json).toBe(true);
		expect(flags.verbose).toBe(true);
		expect(flags.quiet).toBe(true);
		expect(flags.force).toBe(true);
	});

	it("accepts help in both spellings", () => {
		// `-h` is muscle memory. Supporting only `--help` would make the shortest
		// path to help an unknown-option error.
		for (const token of ["--help", "-h"]) {
			expect(parse(["up", token]).flags.help).toBe(true);
			expect(parse(["up", token]).help).toBe(true);
		}
	});

	it("defaults every flag to off or null", () => {
		// The defaults are the contract each command reads. A flag defaulting to
		// `undefined` rather than `null` would make `?? fallback` and `!== null`
		// disagree about whether it was set.
		const flags = parse(["up"]).flags;
		expect(flags.json).toBe(false);
		expect(flags.camp).toBeNull();
		expect(flags.to).toBeNull();
		expect(flags.rollback).toBe(false);
		expect(flags.region).toBeNull();
	});

	it("resolves cwd to an absolute path", () => {
		// Every later file operation is relative to this. A relative cwd would
		// resolve against whatever directory the process happened to be in.
		expect(parse(["up"]).cwd).toBe(path.resolve("/work"));
		expect(parse(["up", "--cwd", "sub"]).flags.cwd).toBe(path.resolve("sub"));
	});

	it("takes a camp name as a value", () => {
		expect(parse(["up", "--camp", "prod"]).flags.camp).toBe("prod");
	});

	it("accepts the template flag in both spellings", () => {
		for (const token of ["-t", "--template"]) {
			expect(parse(["new", token, "api"]).flags.template).toBe("api");
		}
	});
});

describe("value flags", () => {
	it("consumes exactly the next token", () => {
		const flags = parse(["up", "--to", "rev-7", "--camp", "prod"]).flags;
		expect(flags.to).toBe("rev-7");
		expect(flags.camp).toBe("prod");
	});

	it("refuses a value flag at the end of argv", () => {
		// `hobo up --to` with nothing after it. Treating the missing value as
		// empty would deploy to a revision named "".
		expect(() => parse(["up", "--to"])).toThrow(UsageError);
		expect(() => parse(["up", "--to"])).toThrow(/requires a value/u);
	});

	it("refuses a value that looks like another flag", () => {
		// `hobo up --to --json` almost certainly means a forgotten revision.
		// Binding `--json` as the value would deploy something called `--json`
		// and swallow the flag the user did pass.
		expect(() => parse(["up", "--to", "--json"])).toThrow(/requires a value/u);
	});

	it("names the flag in the missing-value error", () => {
		// With a dozen value flags on one line, "requires a value" alone would
		// not say which.
		expect(() => parse(["up", "--camp"])).toThrow(/"--camp"/u);
	});

	it("accepts a value containing a dash that is not leading", () => {
		// Revision ids and camp names routinely contain dashes; only a *leading*
		// dash is the tell of a flag.
		expect(parse(["up", "--to", "rev-7-alpha"]).flags.to).toBe("rev-7-alpha");
	});
});

describe("verb-scoped flags", () => {
	/** Every scoped flag, the verbs that accept it, and whether it takes a value. */
	const scoped = [
		{ flag: "--token", value: true, verbs: ["claim"] },
		{ flag: "--anonymous", value: false, verbs: ["up"] },
		{ flag: "--temporary", value: false, verbs: ["up"] },
		{ flag: "--demo", value: false, verbs: ["serve"] },
		{ flag: "--demo-seed", value: true, verbs: ["serve"] },
		{ flag: "--init", value: false, verbs: ["broker"] },
		{ flag: "--offline", value: false, verbs: ["doctor"] },
		{ flag: "--once", value: false, verbs: ["dev", "serve"] },
		{ flag: "--region", value: true, verbs: ["verify", "up"] },
		{ flag: "--port", value: true, verbs: ["dev", "yard", "serve"] },
		{ flag: "--host", value: true, verbs: ["yard", "dev", "serve"] },
		{ flag: "--broker", value: true, verbs: ["up", "claim", "login"] },
		{ flag: "--broker-uri", value: true, verbs: ["up", "claim", "login"] },
		{ flag: "--config", value: true, verbs: ["broker"] },
		{ flag: "--policies", value: true, verbs: ["broker"] },
		{ flag: "--request", value: true, verbs: ["broker"] },
	] as const;

	it("accepts each scoped flag under every verb that owns it", () => {
		for (const entry of scoped) {
			for (const verb of entry.verbs) {
				const argv = entry.value
					? [verb, entry.flag, "value"]
					: [verb, entry.flag];
				expect(() => parse(argv)).not.toThrow();
			}
		}
	});

	it("refuses each scoped flag under a verb that does not own it", () => {
		// The property this whole section exists for. A silently-ignored
		// `hobo up --token abc` would deploy *without* the token the user
		// believed they passed, and would report success.
		for (const entry of scoped) {
			const foreign = ["up", "dev", "doctor", "claim", "serve", "broker"].find(
				(verb) => !(entry.verbs as readonly string[]).includes(verb),
			);
			expect(foreign).toBeDefined();
			const argv = entry.value
				? [foreign as string, entry.flag, "value"]
				: [foreign as string, entry.flag];
			expect(() => parse(argv)).toThrow(UsageError);
		}
	});

	it("refuses a scoped flag written before its verb", () => {
		// Order-dependent by construction: the verb is read from the stream as it
		// goes, so at the moment `--token` is seen the parser does not yet know
		// this is a claim. Pinned because `hobo --token abc claim` looks
		// reasonable and is rejected.
		expect(() => parse(["--token", "abc", "claim"])).toThrow(UsageError);
		expect(() => parse(["claim", "--token", "abc"])).not.toThrow();
	});

	it("refuses a scoped flag with no verb at all", () => {
		expect(() => parse(["--demo"])).toThrow(UsageError);
	});

	it("keeps --broker and --broker-uri as separate fields", () => {
		// Documented as aliases, but stored apart. Pinned because a caller
		// reading only `flags.broker` would miss a user who wrote `--broker-uri`,
		// and the resolution has to happen deliberately downstream rather than by
		// accident here.
		const canonical = parse(["up", "--broker", "https://a.example"]).flags;
		expect(canonical.broker).toBe("https://a.example");
		expect(canonical.brokerUri).toBeNull();

		const alias = parse(["up", "--broker-uri", "https://b.example"]).flags;
		expect(alias.brokerUri).toBe("https://b.example");
		expect(alias.broker).toBeNull();
	});

	it("keeps --anonymous and --temporary as separate fields too", () => {
		// Same shape, same reason: either one means an anonymous deploy, and the
		// command has to check both.
		expect(parse(["up", "--anonymous"]).flags.temporary).toBe(false);
		expect(parse(["up", "--temporary"]).flags.anonymous).toBe(false);
		expect(parse(["up", "--temporary"]).flags.temporary).toBe(true);
	});

	it("accepts --home for each of its six verbs", () => {
		// The widest scope in the parser — it is both the install root and the
		// profile location, so several unrelated commands legitimately take it.
		for (const verb of ["yard", "dev", "up", "claim", "login", "serve"]) {
			expect(parse([verb, "--home", "/tmp/hobo"]).flags.home).toBe("/tmp/hobo");
		}
		expect(() => parse(["doctor", "--home", "/tmp/hobo"])).toThrow(UsageError);
	});

	it("maps the broker value flags onto their own fields", () => {
		const flags = parse([
			"broker",
			"--config",
			"c.json",
			"--policies",
			"p.json",
			"--request",
			"r.json",
		]).flags;
		expect(flags.config).toBe("c.json");
		expect(flags.policies).toBe("p.json");
		expect(flags.request).toBe("r.json");
	});
});

describe("unknown options", () => {
	it("refuses an option nothing defines", () => {
		expect(() => parse(["up", "--nope"])).toThrow(UsageError);
	});

	it("points at verb help when a verb is known", () => {
		// The useful help target. Sending someone to `hobo --help` when they
		// mistyped a verb-specific flag would show them a list without it.
		expect(() => parse(["up", "--nope"])).toThrow(/hobo up --help/u);
	});

	it("points at top-level help when no verb has been seen", () => {
		expect(() => parse(["--nope"])).toThrow(/hobo --help/u);
	});

	it("carries remediation alongside the message", () => {
		// The CLI renders these as next steps. An error with none would print a
		// complaint and no way forward.
		try {
			parse(["up", "--nope"]);
			expect.unreachable("an unknown option must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(UsageError);
			expect((error as UsageError).remediation?.length).toBeGreaterThan(0);
		}
	});

	it("refuses a single dash as an unknown option", () => {
		// `-` is conventionally stdin elsewhere; here it is not a flag this CLI
		// defines, and treating it as a positional would silently pass it to a
		// command as an argument.
		expect(() => parse(["up", "-"])).toThrow(UsageError);
	});
});

describe("mutually exclusive revision selectors", () => {
	it("refuses --to together with --rollback", () => {
		// Two different revisions to deploy. Picking one silently would deploy
		// something other than what was asked for — and which one won would
		// depend on parse order, not on intent.
		expect(() => parse(["up", "--to", "rev-7", "--rollback"])).toThrow(
			UsageError,
		);
		expect(() => parse(["up", "--rollback", "--to", "rev-7"])).toThrow(
			/cannot be combined/u,
		);
	});

	it("accepts either one alone", () => {
		expect(parse(["up", "--to", "rev-7"]).flags.rollback).toBe(false);
		expect(parse(["up", "--rollback"]).flags.to).toBeNull();
	});

	it("checks the combination after the whole line is parsed", () => {
		// Not at the point either flag is seen — the conflict only exists once
		// both are known, and checking early would reject a valid line depending
		// on which came first.
		expect(() =>
			parse(["up", "--to", "rev-7", "--json", "--rollback"]),
		).toThrow(UsageError);
	});
});

describe("verb validation", () => {
	it("accepts a known verb", () => {
		expect(() => assertKnownVerb("up")).not.toThrow();
	});

	it("refuses an unknown verb", () => {
		expect(() => assertKnownVerb("upp")).toThrow(UsageError);
	});

	it("suggests the nearest verb for a near miss", () => {
		// A single-character typo is the common case, and the suggestion is what
		// saves a round trip to `--help`.
		expect(unknownVerbMessage("upp")).toContain('Did you mean "up"');
	});

	it("always names what was typed", () => {
		// So the message is actionable even when the suggestion is wrong or
		// absent.
		expect(unknownVerbMessage("zzzz")).toContain('"zzzz"');
	});

	it("points at top-level help", () => {
		expect(unknownVerbMessage("zzzz")).toContain("hobo --help");
	});

	it("stays silent rather than guessing at a distant input", () => {
		// A confidently wrong suggestion is worse than none: it sends someone to
		// run a command they did not want. `zzzz` is nowhere near any verb, so
		// the message echoes what was typed and stops.
		expect(unknownVerbMessage("zzzz")).not.toMatch(/Did you mean/u);
	});

	it("tightens the suggestion threshold for short inputs", () => {
		// The rule is length-dependent: distance ≤1 for inputs up to four
		// characters, ≤2 beyond. Short verbs are cheap to fat-finger *into
		// another valid word*, so a two-edit guess on a four-character input is
		// as likely to name the wrong command as the right one.
		//
		// `dveo` is four characters and two edits from `dev`, so it gets no
		// suggestion; `dveop` is five and two edits from `deploy`-family verbs,
		// so it does.
		expect(unknownVerbMessage("dveo")).not.toMatch(/Did you mean/u);
		expect(unknownVerbMessage("verifyy")).toMatch(/Did you mean/u);
	});

	it("suggests for a one-edit miss on a short verb", () => {
		// The other side of the same threshold: one edit is always close enough.
		expect(unknownVerbMessage("dev1")).toContain('Did you mean "dev"');
	});
});
