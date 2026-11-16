import { describe, expect, it } from "vitest";
import {
	checkPullRequestTitle,
	DEFAULT_PULL_REQUEST_TITLE_TYPES,
	parseTitleTypes,
} from "../src/insights/pr-title.js";

/** The reason a title was rejected; fails the test when it was accepted. */
function reasonFor(title: string, types?: readonly string[]): string {
	const check =
		types === undefined
			? checkPullRequestTitle(title)
			: checkPullRequestTitle(title, { types });
	if (check.ok) throw new Error(`expected "${title}" to be rejected`);
	return check.reason;
}

describe("checkPullRequestTitle", () => {
	it("publishes the default types", () => {
		expect(DEFAULT_PULL_REQUEST_TITLE_TYPES).toEqual([
			"feat",
			"fix",
			"docs",
			"style",
			"refactor",
			"perf",
			"test",
			"build",
			"ci",
			"chore",
			"revert",
		]);
	});

	it.each([
		...DEFAULT_PULL_REQUEST_TITLE_TYPES,
	])("accepts the default type %s", (type) => {
		expect(checkPullRequestTitle(`${type}: do the thing`)).toEqual({
			ok: true,
			type,
			breaking: false,
		});
	});

	it("accepts a plain title without a scope key", () => {
		const check = checkPullRequestTitle("feat: add retry");
		expect(check).toEqual({ ok: true, type: "feat", breaking: false });
		expect("scope" in check).toBe(false);
	});

	it("reads the scope", () => {
		expect(checkPullRequestTitle("fix(api): handle empty body")).toEqual({
			ok: true,
			type: "fix",
			scope: "api",
			breaking: false,
		});
		expect(checkPullRequestTitle("fix(ci/mesh, a:b): x")).toMatchObject({
			ok: true,
			scope: "ci/mesh, a:b",
		});
	});

	it("reads the breaking mark, with or without a scope", () => {
		expect(checkPullRequestTitle("feat!: drop node 18")).toEqual({
			ok: true,
			type: "feat",
			breaking: true,
		});
		expect(checkPullRequestTitle("feat(api)!: drop v1")).toEqual({
			ok: true,
			type: "feat",
			scope: "api",
			breaking: true,
		});
	});

	it("accepts a subject that itself contains colons and parentheses", () => {
		expect(checkPullRequestTitle("docs: note: see (below)")).toMatchObject({
			ok: true,
			type: "docs",
		});
	});

	it.each([
		"",
		"123: numbers",
		" feat: leading space",
		"(api): no type",
		": x",
	])("rejects %j for not starting with a type", (title) => {
		expect(reasonFor(title)).toContain("must start with a type");
	});

	it.each([
		"Update readme",
		"feat add retry",
		"feat",
		"feat - add",
		"feat(api) x",
	])("rejects %j for the missing colon", (title) => {
		const reason = reasonFor(title);
		expect(reason).toContain("followed by a colon and a space");
		expect(reason).toContain('"feat: add retry"');
	});

	it("rejects a scope that is not closed", () => {
		expect(reasonFor("feat(api: add retry")).toContain(
			"missing its closing parenthesis",
		);
	});

	it("rejects an empty scope", () => {
		expect(reasonFor("feat(): add retry")).toContain("is empty");
		expect(reasonFor("feat( ): add retry")).toContain("is empty");
	});

	it("rejects a scope with parentheses or line breaks inside", () => {
		expect(reasonFor("feat((api)): add retry")).toContain(
			"must not contain parentheses or line breaks",
		);
		expect(reasonFor("feat(a\nb): add retry")).toContain(
			"must not contain parentheses or line breaks",
		);
		expect(reasonFor("feat(a\rb): add retry")).toContain(
			"must not contain parentheses or line breaks",
		);
	});

	it("rejects an empty subject", () => {
		expect(reasonFor("feat:")).toContain("subject after the colon is empty");
		expect(reasonFor("feat: ")).toContain("subject after the colon is empty");
		expect(reasonFor("feat(api)!:   ")).toContain(
			"subject after the colon is empty",
		);
	});

	it("rejects a missing space after the colon and shows the fix", () => {
		expect(reasonFor("feat:add retry")).toBe(
			'Put a space after the colon: "feat: add retry".',
		);
		expect(reasonFor("fix(api)!:handle it")).toBe(
			'Put a space after the colon: "fix(api)!: handle it".',
		);
	});

	it("rejects more than one space after the colon", () => {
		expect(reasonFor("feat:  add retry")).toContain("exactly one space");
		expect(reasonFor("feat: \tadd retry")).toContain("exactly one space");
	});

	it("rejects an unknown type and lists the allowed ones", () => {
		expect(reasonFor("wip: try something")).toBe(
			'Unknown type "wip". Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
		);
	});

	it("matches the type exactly and points at the right spelling", () => {
		expect(reasonFor("Feat: add retry")).toBe(
			'Unknown type "Feat". Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Types are matched exactly: write "feat".',
		);
	});

	it("reports the form before the type", () => {
		expect(reasonFor("wip:")).toContain("subject after the colon is empty");
		expect(reasonFor("wip(): x")).toContain("is empty");
	});

	it("uses the caller's types when given", () => {
		const types = ["feature", "bug"];
		expect(checkPullRequestTitle("feature: add retry", { types })).toEqual({
			ok: true,
			type: "feature",
			breaking: false,
		});
		expect(reasonFor("feat: add retry", types)).toBe(
			'Unknown type "feat". Use one of: feature, bug.',
		);
	});

	it("falls back to the default types for an empty list", () => {
		expect(checkPullRequestTitle("feat: add retry", { types: [] }).ok).toBe(
			true,
		);
		expect(reasonFor("wip: x", [])).toContain("Use one of: feat, fix");
	});
});

describe("parseTitleTypes", () => {
	it("splits on commas and line breaks", () => {
		expect(parseTitleTypes("feat,fix\ndocs\r\nchore")).toEqual([
			"feat",
			"fix",
			"docs",
			"chore",
		]);
	});

	it("trims entries and drops empty ones", () => {
		expect(parseTitleTypes(" feat , ,\n\n  fix  ,")).toEqual(["feat", "fix"]);
		expect(parseTitleTypes("")).toEqual([]);
		expect(parseTitleTypes(" , \n ")).toEqual([]);
	});

	it("drops repeats, keeping the first", () => {
		expect(parseTitleTypes("fix, feat, fix, Feat, feat")).toEqual([
			"fix",
			"feat",
			"Feat",
		]);
	});

	it("feeds the title check", () => {
		const types = parseTitleTypes("feature, bug");
		expect(checkPullRequestTitle("bug: fix it", { types }).ok).toBe(true);
	});
});
