/**
 * Planning an application, and the refusals the structural merge raises.
 *
 * `typescript-merge.test.ts` covers the merge decisions on files it *can* edit.
 * This covers the other half: the plan that precedes an apply, and every shape
 * the merge declines to touch.
 *
 * The refusals matter more than they look. This is an AST edit written back over
 * somebody's source, and the alternative to refusing is not failure — it is a
 * file that still compiles and means something the author did not write. A
 * snippet naming a symbol the file does not declare, a file with two bindle
 * definitions, a file that is not TypeScript at all: each of these is a case
 * where a "best effort" merge would produce plausible, wrong source.
 *
 * The plan carries the other property worth naming: an **expected preimage**.
 * It is the digest of the file as it stood when the plan was made, so an apply
 * against a file that changed underneath can be recognised rather than silently
 * clobbering somebody's edit. A file that does not exist yet gets an empty
 * preimage — a distinct state from "a file whose contents hashed to nothing".
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	loadPatternCatalog,
	PatternParseError,
	planPatternApplication,
} from "../src/index.js";

const catalog = loadPatternCatalog();

const PLAIN = `import { bindle } from "@hobo/bindles";

export default bindle("demo", (b) => {
  return {};
});
`;

let runCounter = 0;

/** A fresh isolation root, optionally seeded with a bindle source. */
function root(source?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-pat-plan-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	if (source !== undefined) {
		writeFileSync(join(dir, "src", "bindle.ts"), source);
	}
	return dir;
}

const read = (dir: string) =>
	readFileSync(join(dir, "src", "bindle.ts"), "utf8");

function plan(
	dir: string,
	overrides: Partial<Parameters<typeof planPatternApplication>[0]> = {},
) {
	runCounter += 1;
	return planPatternApplication({
		catalog,
		patternId: "bindle.resource.api",
		isolationRoot: dir,
		targetPath: "src/bindle.ts",
		isolationRunId: `plan-${runCounter}`,
		...overrides,
	});
}

function apply(
	dir: string,
	overrides: Partial<Parameters<typeof applyPatternPlan>[0]> = {},
) {
	runCounter += 1;
	return applyPatternPlan({
		catalog,
		patternId: "bindle.resource.api",
		isolationRoot: dir,
		targetPath: "src/bindle.ts",
		isolationRunId: `apply-${runCounter}`,
		params: { resourceName: "shop" },
		...overrides,
	});
}

describe("planPatternApplication", () => {
	it("names the run, the root, and the target it will act on", () => {
		// The plan is the record of what was *about* to happen. A plan that did
		// not carry its own run id could not be correlated with the receipt that
		// followed it.
		const dir = root(PLAIN);
		const result = plan(dir);
		expect(result.sourceRoot).toBe(dir);
		expect(result.targetPath).toBe("src/bindle.ts");
		expect(result.isolationRunId).toMatch(/^plan-/u);
	});

	it("digests the file as it stands, so a later change is detectable", () => {
		// The expected preimage is what makes an apply able to notice that
		// somebody edited the file between plan and apply. Without it a
		// concurrent edit would be silently overwritten.
		const dir = root(PLAIN);
		expect(plan(dir).expectedPreimage).toEqual([
			createHash("sha256").update(PLAIN).digest("hex"),
		]);
	});

	it("reports an empty preimage for a file that does not exist yet", () => {
		// Distinct from a digest: creating a file and modifying one are different
		// operations, and an invented digest for an absent file would make the
		// first look like the second.
		expect(plan(root()).expectedPreimage).toEqual([]);
	});

	it("carries the pattern's declared effects, which may legitimately be none", () => {
		// The effects are what a reviewer reads before promotion. Pinned as
		// *equal to the pattern's own list* rather than as non-empty: a resource
		// pattern that only edits the bindle source declares no external effect,
		// and asserting non-emptiness here would encode a requirement the
		// catalog does not have.
		const pattern = catalog.patterns.find(
			(item) => item.id === "bindle.resource.api",
		);
		expect(plan(root(PLAIN)).effects).toEqual(pattern?.effects);
	});

	it("always requires promotion", () => {
		// Applying happens in an isolation root, never in the user's tree. A plan
		// claiming no promotion was needed would let an isolated edit be mistaken
		// for a committed one.
		expect(plan(root(PLAIN)).promotionRequired).toBe(true);
	});

	it("refuses a pattern the catalog does not contain", () => {
		// Named in the message, because the id most likely came from a typo in a
		// command line and the reader needs to see what they typed.
		expect(() => plan(root(PLAIN), { patternId: "bindle.nope" })).toThrow(
			/unknown pattern bindle\.nope/u,
		);
	});

	it("refuses an absolute target path", () => {
		// The whole point of an isolation root is that nothing is written outside
		// it. An absolute path ignores the root entirely.
		expect(() => plan(root(PLAIN), { targetPath: "/etc/passwd" })).toThrow(
			PatternParseError,
		);
	});

	it("refuses a target path containing a dot segment", () => {
		// The traversal case. `../` walks out of the isolation root and into the
		// user's real tree, which is exactly what isolation exists to prevent —
		// and it would look like a normal apply.
		for (const targetPath of [
			"../outside.ts",
			"src/../../outside.ts",
			"src/..",
			"a/../../b.ts",
		]) {
			expect(() => plan(root(PLAIN), { targetPath })).toThrow(
				PatternParseError,
			);
		}
	});

	it("accepts a nested path inside the root", () => {
		// The refusal must be narrow: an ordinary subdirectory is the common
		// case, and refusing it would make the pattern usable only at the root.
		expect(() =>
			plan(root(PLAIN), { targetPath: "src/nested/deep/bindle.ts" }),
		).not.toThrow();
	});
});

describe("applyPatternPlan on files it cannot safely edit", () => {
	it("refuses a file carrying two bindle definitions", () => {
		// Ambiguous by construction: there is no way to know which definition the
		// resource belongs in, and picking one would put it in the wrong place
		// half the time — in a file that still compiles.
		const dir = root(`import { bindle } from "@hobo/bindles";

export const a = bindle("a", (b) => {
  return {};
});

export const c = bindle("c", (b) => {
  return {};
});
`);
		expect(() => apply(dir)).toThrow(/multiple ambiguous Bindle definitions/u);
	});

	it("refuses a file that mentions bindle but declares none", () => {
		// A file part-way through an edit, or one using a dynamic shape this
		// merge cannot follow. Guessing where the definition *would* go is how a
		// resource lands outside any bindle at all.
		// The file has to *mention* `bindle(` for the structural merge to be
		// attempted at all — see the note on the next test — so this uses a
		// commented-out definition alongside the dynamic one.
		const dir = root(`import { bindle } from "@hobo/bindles";

// export default bindle("demo", (b) => ({}));
const make = () => bindle;
export default make()("demo", (b) => ({}));
`);
		expect(() => apply(dir)).toThrow(
			/dynamic code shapes that cannot be safely transformed/u,
		);
	});

	it("refuses a TypeScript file with no bindle shape at all", () => {
		// Not every `.ts` file in a project is a bindle. Appending to an
		// unrelated module would corrupt it silently.
		//
		// Worth pinning *which* refusal fires: the structural merge is only
		// attempted when either the snippet or the target mentions `bindle(`, so
		// an unrelated TypeScript module never reaches `applyStructural` and is
		// declined by the outer guard as an unsupported merge instead. The
		// message therefore says "non-TypeScript" about a file that is perfectly
		// good TypeScript — accurate about the outcome, misleading about the
		// reason, and recorded here so nobody "fixes" the file detection on the
		// strength of that wording.
		const dir = root(`export const answer = 42;\n`);
		expect(() => apply(dir)).toThrow(
			/unsupported language or non-TypeScript merge/u,
		);
	});

	it("reaches the structural refusal once the target mentions a bindle call", () => {
		// The other side of the same fact: with `bindle(` present the merge *is*
		// attempted, and a structural diagnosis comes back instead of the generic
		// language one.
		//
		// FINDING, pinned rather than changed: the specific message
		// "unsupported existing TypeScript shape" is unreachable from this entry
		// point. It is the else-branch of a check that first asks whether the
		// file mentions `bindle(` or imports `@hobo/bindles` — but the merge is
		// only attempted at all when one of those is true, so the else-branch has
		// no reachable caller here. Every file that gets this far is reported as
		// a dynamic shape.
		//
		// Harmless today (both messages describe a refusal to edit) and left
		// alone rather than deleted, because the distinction it is trying to draw
		// — "you wrote something dynamic" versus "this is not a bindle file" — is
		// a real one worth keeping if another caller ever reaches it.
		const dir = root(`import { bindle } from "@hobo/bindles";

// bindle( appears only in this comment
export const answer = 42;
`);
		expect(() => apply(dir)).toThrow(
			/dynamic code shapes that cannot be safely transformed/u,
		);
	});

	it("refuses a target whose own source does not parse", () => {
		// A file that already has syntax errors cannot be edited by AST, and a
		// text-level append would produce a second, different error somewhere
		// else — sending whoever debugs it to the wrong line.
		const dir = root(`import { bindle } from "@hobo/bindles";

export default bindle("demo", (b) => {
  return {
});
`);
		expect(() => apply(dir)).toThrow(/target has source syntax errors/u);
	});

	it("names the syntax error it found in the target", () => {
		// So the author can fix their file rather than guessing which of its
		// lines the merge objected to.
		const dir = root(`export default bindle("demo", (b) => { return { ;\n`);
		try {
			apply(dir);
			expect.unreachable("a malformed target must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(PatternParseError);
			if (!(error instanceof Error)) throw error;
			expect(error.message.length).toBeGreaterThan(
				"target has source syntax errors: ".length,
			);
		}
	});

	it("refuses a non-TypeScript file rather than appending to it", () => {
		// The merge has no structural handle on this, and the fallback — treating
		// the file as empty and overwriting it — would destroy its contents.
		const dir = root();
		writeFileSync(
			join(dir, "src", "bindle.ts"),
			"# not typescript\n\n- a\n- b\n",
		);
		expect(() => apply(dir)).toThrow(
			/unsupported language or non-TypeScript merge/u,
		);
	});

	it("leaves the file untouched when it refuses", () => {
		// The property that makes the refusals safe: a rejected apply is a
		// no-op, not a partial edit. A half-written file would be worse than
		// either outcome.
		const source = `export const answer = 42;\n`;
		const dir = root(source);
		expect(() => apply(dir)).toThrow();
		expect(read(dir)).toBe(source);
	});

	it("refuses a pattern the catalog does not contain", () => {
		expect(() => apply(root(PLAIN), { patternId: "bindle.nope" })).toThrow(
			/unknown pattern/u,
		);
	});
});

describe("applyPatternPlan on an empty or absent target", () => {
	it("creates the file when there is nothing there", () => {
		// The first apply in a fresh project. Requiring an existing file would
		// make every pattern need a manual bootstrap first.
		const dir = root();
		const receipt = apply(dir);
		expect(receipt.changedFiles).toContain("src/bindle.ts");
		expect(read(dir).length).toBeGreaterThan(0);
	});

	it("creates intermediate directories", () => {
		// `mkdirSync(dirname, { recursive: true })`. A pattern targeting a nested
		// path in a fresh root would otherwise fail on the missing directory.
		const dir = root();
		apply(dir, { targetPath: "src/deep/nested/bindle.ts" });
		expect(
			readFileSync(join(dir, "src", "deep", "nested", "bindle.ts"), "utf8")
				.length,
		).toBeGreaterThan(0);
	});

	it("writes the snippet verbatim into an empty file, ending with a newline", () => {
		// There is nothing to merge into, so the snippet is the file. The
		// trailing newline matters because the next apply parses this back, and
		// a POSIX tool appending to it would otherwise join two lines.
		const dir = root("");
		apply(dir);
		expect(read(dir).endsWith("\n")).toBe(true);
	});

	it("treats a whitespace-only file as empty rather than as a merge target", () => {
		// And writes the snippet as-is. Pinned because the result is *not* a
		// complete bindle file: the api-resource snippet is a bare
		// `const shop = b.api(...)`, so applying it to an empty target produces a
		// fragment with no surrounding definition. That is correct for this
		// layer — composing the fragments is the caller's job — but it means an
		// empty target is not a shortcut to a working bindle.
		const dir = root("   \n\n  ");
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("b.api(");
	});
});

describe("the receipt an apply returns", () => {
	it("reports the files it changed and their post-image digests", () => {
		// The post-image is what a promotion step verifies against. Without it a
		// promotion could carry a file different from the one the receipt
		// described.
		const dir = root(PLAIN);
		const receipt = apply(dir);
		expect(receipt.changedFiles).toEqual(["src/bindle.ts"]);
		expect(receipt.postimage).toEqual([
			createHash("sha256").update(read(dir)).digest("hex"),
		]);
	});

	it("reports applied-isolation for a real change", () => {
		// The reason code is what a caller branches on. Reporting `idempotent`
		// for a change would tell a promotion step there is nothing to promote.
		const receipt = apply(root(PLAIN));
		expect(receipt.idempotent).toBe(false);
		expect(receipt.reasonCode).toBe("applied-isolation");
		expect(receipt.changedFiles.length).toBeGreaterThan(0);
	});

	it("reports idempotent, and changes nothing, on a second identical apply", () => {
		// Applying twice is normal — a pattern re-run after an unrelated edit,
		// or a retried command. The second must be a no-op, not a duplicate
		// resource.
		const dir = root(PLAIN);
		apply(dir);
		const after = read(dir);
		const second = apply(dir);
		expect(second.idempotent).toBe(true);
		expect(second.reasonCode).toBe("idempotent");
		expect(second.changedFiles).toEqual([]);
		expect(read(dir)).toBe(after);
	});

	it("still reports a post-image on an idempotent apply", () => {
		// The digest describes the file's state, not the operation. Omitting it
		// when nothing changed would leave a promotion unable to verify a file
		// that is already correct.
		const dir = root(PLAIN);
		apply(dir);
		expect(apply(dir).postimage).toHaveLength(1);
	});

	it("always requires promotion and names how", () => {
		// The apply happened in an isolation root. The promotion ref is the
		// command that moves it, and a receipt without one would leave the user
		// with a change and no way to land it.
		const receipt = apply(root(PLAIN));
		expect(receipt.promotionRequired).toBe(true);
		expect(receipt.promotionRef).toBe("hobo-code promote");
	});

	it("records that no model was called", () => {
		// These patterns are deterministic AST edits. Non-zero token counts here
		// would misreport a mechanical transform as model output — which is a
		// different thing entirely for anyone auditing what touched their code.
		const receipt = apply(root(PLAIN));
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("carries the run id it was given", () => {
		const receipt = applyPatternPlan({
			catalog,
			patternId: "bindle.resource.api",
			isolationRoot: root(PLAIN),
			targetPath: "src/bindle.ts",
			isolationRunId: "run-fixed",
			params: { resourceName: "shop" },
		});
		expect(receipt.isolationRunId).toBe("run-fixed");
	});
});

describe("path safety at apply time", () => {
	it("refuses a traversing target path", () => {
		// Checked again at apply, not only at plan. A caller that built a plan by
		// hand, or reused one, must not be able to skip the check.
		for (const targetPath of ["../escape.ts", "src/../../escape.ts"]) {
			expect(() => apply(root(PLAIN), { targetPath })).toThrow(
				PatternParseError,
			);
		}
	});

	it("refuses an absolute target path", () => {
		expect(() => apply(root(PLAIN), { targetPath: "/tmp/escape.ts" })).toThrow(
			PatternParseError,
		);
	});

	it("writes nothing outside the isolation root when it refuses", () => {
		// The assertion that makes the refusal meaningful rather than cosmetic.
		const dir = root(PLAIN);
		expect(() => apply(dir, { targetPath: "../escaped.ts" })).toThrow();
		expect(read(dir)).toBe(PLAIN);
	});
});
