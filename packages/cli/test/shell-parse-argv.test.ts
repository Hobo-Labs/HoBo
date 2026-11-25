import path from "node:path";
import { describe, expect, it } from "vitest";

import { UsageError } from "../src/shell/errors.js";
import {
	assertKnownVerb,
	parseArgv,
	unknownVerbMessage,
} from "../src/shell/parse.js";

function parse(argv: readonly string[]) {
	return parseArgv(argv, { cwd: "/work" });
}

describe("verb and positional arguments", () => {
	it("reads the first bare token as the verb", () => {
		expect(parse(["up"]).verb).toBe("up");
	});

	it("reports no verb for an empty argv", () => {
		expect(parse([]).verb).toBeNull();
		expect(parse([]).args).toEqual([]);
	});

	it("collects later bare tokens as arguments", () => {
		const request = parse(["yard", "init", "local"]);
		expect(request.verb).toBe("yard");
		expect(request.args).toEqual(["init", "local"]);
	});

	it("keeps argument order", () => {
		expect(parse(["yard", "a", "b", "c"]).args).toEqual(["a", "b", "c"]);
	});

	it("stops interpreting flags after a bare double dash", () => {
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
		for (const token of ["--help", "-h"]) {
			expect(parse(["up", token]).flags.help).toBe(true);
			expect(parse(["up", token]).help).toBe(true);
		}
	});

	it("defaults every flag to off or null", () => {
		const flags = parse(["up"]).flags;
		expect(flags.json).toBe(false);
		expect(flags.camp).toBeNull();
		expect(flags.to).toBeNull();
		expect(flags.rollback).toBe(false);
		expect(flags.region).toBeNull();
	});

	it("resolves cwd to an absolute path", () => {
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
		expect(() => parse(["up", "--to"])).toThrow(UsageError);
		expect(() => parse(["up", "--to"])).toThrow(/requires a value/u);
	});

	it("refuses a value that looks like another flag", () => {
		expect(() => parse(["up", "--to", "--json"])).toThrow(/requires a value/u);
	});

	it("names the flag in the missing-value error", () => {
		expect(() => parse(["up", "--camp"])).toThrow(/"--camp"/u);
	});

	it("accepts a value containing a dash that is not leading", () => {
		expect(parse(["up", "--to", "rev-7-alpha"]).flags.to).toBe("rev-7-alpha");
	});
});

describe("verb-scoped flags", () => {
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
		expect(() => parse(["--token", "abc", "claim"])).toThrow(UsageError);
		expect(() => parse(["claim", "--token", "abc"])).not.toThrow();
	});

	it("refuses a scoped flag with no verb at all", () => {
		expect(() => parse(["--demo"])).toThrow(UsageError);
	});

	it("keeps --broker and --broker-uri as separate fields", () => {
		const canonical = parse(["up", "--broker", "https://a.example"]).flags;
		expect(canonical.broker).toBe("https://a.example");
		expect(canonical.brokerUri).toBeNull();

		const alias = parse(["up", "--broker-uri", "https://b.example"]).flags;
		expect(alias.brokerUri).toBe("https://b.example");
		expect(alias.broker).toBeNull();
	});

	it("keeps --anonymous and --temporary as separate fields too", () => {
		expect(parse(["up", "--anonymous"]).flags.temporary).toBe(false);
		expect(parse(["up", "--temporary"]).flags.anonymous).toBe(false);
		expect(parse(["up", "--temporary"]).flags.temporary).toBe(true);
	});

	it("accepts --home for each of its six verbs", () => {
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
		expect(() => parse(["up", "--nope"])).toThrow(/hobo up --help/u);
	});

	it("points at top-level help when no verb has been seen", () => {
		expect(() => parse(["--nope"])).toThrow(/hobo --help/u);
	});

	it("carries remediation alongside the message", () => {
		try {
			parse(["up", "--nope"]);
			expect.unreachable("an unknown option must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(UsageError);
			expect((error as UsageError).remediation?.length).toBeGreaterThan(0);
		}
	});

	it("refuses a single dash as an unknown option", () => {
		expect(() => parse(["up", "-"])).toThrow(UsageError);
	});
});

describe("mutually exclusive revision selectors", () => {
	it("refuses --to together with --rollback", () => {
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
		expect(unknownVerbMessage("upp")).toContain('Did you mean "up"');
	});

	it("always names what was typed", () => {
		expect(unknownVerbMessage("zzzz")).toContain('"zzzz"');
	});

	it("points at top-level help", () => {
		expect(unknownVerbMessage("zzzz")).toContain("hobo --help");
	});

	it("stays silent rather than guessing at a distant input", () => {
		expect(unknownVerbMessage("zzzz")).not.toMatch(/Did you mean/u);
	});

	it("tightens the suggestion threshold for short inputs", () => {
		expect(unknownVerbMessage("dveo")).not.toMatch(/Did you mean/u);
		expect(unknownVerbMessage("verifyy")).toMatch(/Did you mean/u);
	});

	it("suggests for a one-edit miss on a short verb", () => {
		expect(unknownVerbMessage("dev1")).toContain('Did you mean "dev"');
	});
});
