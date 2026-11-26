/**
 * The verb catalog, the JSON envelope, and build-error remediation.
 *
 * Three small surfaces that together decide what a user and a script each see
 * when a command finishes.
 *
 * **The envelope is the machine-readable contract.** Every field is always
 * present — a script reading `.ok` or `.code` must never get `undefined`,
 * because `undefined` is falsy and a consumer branching on it would treat a
 * successful run as a failure. That is why the builder fills defaults rather
 * than spreading whatever a command happened to return.
 *
 * **`publicContext` is a projection, not a pass-through.** The envelope is
 * printed and piped, so what goes in it is a deliberate subset of the context
 * the CLI holds internally.
 *
 * **Remediation is the difference between a failure and a next step.** Every
 * build error maps to something the user can actually do; the fallback is
 * `--json`, which is the only universally-useful advice when nothing more
 * specific is known.
 */
import { describe, expect, it } from "vitest";

import {
	BuildCliError,
	BuildError,
	type BuildErrorCode,
	remediationFor,
} from "../src/build/errors.js";
import type { JsonObject } from "../src/json.js";
import { CliError } from "../src/shell/errors.js";
import {
	CANONICAL_VERBS,
	GLOBAL_FLAGS,
	helpText,
	projectScopedVerbs,
	verbHelpText,
	verbNames,
} from "../src/shell/verbs.js";
import {
	buildEnvelope,
	type CommandResult,
	publicContext,
} from "../src/types/envelope.js";

const CONTEXT = {
	cwd: "/work",
	projectDir: "/work/app",
	identity: "user-1",
	clients: { readApi: "http://read", runtime: "http://runtime" },
};

describe("the verb catalog", () => {
	it("names every verb uniquely", () => {
		// Two verbs sharing a name would make dispatch depend on list order, and
		// the help output would show the same command twice.
		const names = CANONICAL_VERBS.map((verb) => verb.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("gives every verb a role and a summary", () => {
		// Both are rendered in help. A blank summary would print a verb with no
		// indication of what it does, which is worse than not listing it.
		for (const verb of CANONICAL_VERBS) {
			expect(verb.name.length).toBeGreaterThan(0);
			expect(verb.role.length).toBeGreaterThan(0);
			expect(verb.summary.length).toBeGreaterThan(0);
		}
	});

	it("derives the name set from the catalog", () => {
		// One source of truth. A hand-maintained set would drift, and the drift
		// would surface as a verb that help lists and dispatch rejects.
		expect(verbNames.size).toBe(CANONICAL_VERBS.length);
		for (const verb of CANONICAL_VERBS) {
			expect(verbNames.has(verb.name)).toBe(true);
		}
	});

	it("excludes the verbs that legitimately run outside a project", () => {
		// `hobo new` creates the project; `hobo doctor` diagnoses a machine with
		// no project at all. Marking them project-scoped would make the two
		// commands a new user runs first fail with "not in a HoBo project".
		for (const verb of ["new", "doctor", "login", "claim"]) {
			expect(projectScopedVerbs.has(verb)).toBe(false);
		}
	});

	it("scopes the lifecycle verbs to a project", () => {
		// The other side: `hobo up` outside a project has nothing to deploy, and
		// failing early with a clear reason beats failing deep in a loader.
		for (const verb of ["up", "down", "dev"]) {
			expect(projectScopedVerbs.has(verb)).toBe(true);
		}
	});

	it("only lists real verbs as project-scoped", () => {
		// The set is built by filtering the catalog, so a typo in the exclusion
		// list cannot invent a verb — but it could fail to exclude one, which
		// this catches by construction.
		for (const verb of projectScopedVerbs) {
			expect(verbNames.has(verb)).toBe(true);
		}
	});
});

describe("help text", () => {
	it("lists every canonical verb", () => {
		// A verb missing from help is a verb nobody discovers.
		const text = helpText();
		for (const verb of CANONICAL_VERBS) {
			expect(text).toContain(verb.name);
		}
	});

	it("documents every global flag", () => {
		// The flags are parsed whether or not they are documented; an
		// undocumented one is a feature only the source reveals.
		const text = helpText();
		for (const flag of GLOBAL_FLAGS) {
			const name = flag.split(" ")[0] ?? flag;
			expect(text).toContain(name);
		}
	});

	it("opens with a concrete first-run path", () => {
		// The "start here" block is what turns an install into a running app.
		// Listing verbs alone would leave a new user to guess the order.
		const text = helpText();
		expect(text).toContain("hobo doctor");
		expect(text).toContain("hobo new");
		expect(text).toContain("hobo dev");
	});

	it("is stable across calls", () => {
		expect(helpText()).toBe(helpText());
	});
});

describe("verb help", () => {
	it("renders help for every catalog verb", () => {
		for (const verb of CANONICAL_VERBS) {
			expect(verbHelpText(verb.name).length).toBeGreaterThan(0);
		}
	});

	it("refuses a verb the catalog does not contain", () => {
		// A programming error rather than a user one — the caller validated the
		// verb before getting here — so it throws rather than returning empty
		// help that would read as a verb with nothing to say.
		expect(() => verbHelpText("nope")).toThrow(/unknown verb/u);
	});

	it("says nothing about implementation status when not told", () => {
		// The deliberate third state. Help rendered without registry knowledge
		// must not claim a verb is implemented *or* that it is not — both would
		// be assertions the renderer cannot back.
		expect(verbHelpText("up")).not.toContain("Status:");
	});

	it("reports implementation status in both directions when told", () => {
		expect(verbHelpText("up", { implemented: true })).toContain("Status:");
		expect(verbHelpText("up", { implemented: false })).toContain("Status:");
		expect(verbHelpText("up", { implemented: true })).not.toBe(
			verbHelpText("up", { implemented: false }),
		);
	});

	it("names the verb it is describing", () => {
		expect(verbHelpText("doctor")).toContain("doctor");
	});
});

describe("publicContext", () => {
	it("carries the fields a caller needs to interpret the envelope", () => {
		expect(publicContext(CONTEXT)).toEqual(CONTEXT);
	});

	it("normalizes an absent identity to null", () => {
		// `?? null`. An undefined identity would disappear from the JSON
		// entirely, and a consumer checking `"identity" in context` would get a
		// different answer than one checking `context.identity === null`.
		// SAFETY: deliberately malformed identity exercises the projection's missing-field fallback.
		expect(
			publicContext({ ...CONTEXT, identity: undefined } as never).identity,
		).toBeNull();
	});

	it("keeps a null project directory as null", () => {
		// Null means "not inside a project", which is a real state for `doctor`
		// and `new`. Coercing it to a string would name a directory that is not
		// a project.
		expect(
			publicContext({ ...CONTEXT, projectDir: null }).projectDir,
		).toBeNull();
	});

	it("rebuilds the object rather than passing the caller's through", () => {
		// The projection is what stops an internal field being added to the
		// context later and silently appearing in every envelope on stdout.
		const extended = { ...CONTEXT, secretToken: "s3cr3t" };
		const projected = publicContext(extended);
		expect(Object.hasOwn(projected, "secretToken")).toBe(false);
		expect(JSON.stringify(projected)).not.toContain("s3cr3t");
	});
});

describe("buildEnvelope", () => {
	function envelope(result: CommandResult = {}) {
		return buildEnvelope({ verb: "up", context: CONTEXT, result });
	}

	it("fills every field even for an empty result", () => {
		// The contract a script reads. An absent `ok` or `code` would be
		// `undefined` — falsy — and a consumer branching on it would treat a
		// successful run as a failure.
		const built = envelope();
		expect(built).toEqual({
			ok: true,
			verb: "up",
			status: "ok",
			code: "HOBO_OK",
			message: "",
			remediation: [],
			context: CONTEXT,
			data: {},
		});
	});

	it("treats only an explicit false as failure", () => {
		// `result.ok !== false`. A command that returned nothing succeeded; only
		// one that said so failed. Testing truthiness instead would make an
		// omitted `ok` a failure and break every command that does not set it.
		expect(envelope({}).ok).toBe(true);
		expect(envelope({ ok: undefined }).ok).toBe(true);
		expect(envelope({ ok: true }).ok).toBe(true);
		expect(envelope({ ok: false }).ok).toBe(false);
	});

	it("derives status and code from ok when the command states neither", () => {
		const failed = envelope({ ok: false });
		expect(failed.status).toBe("error");
		expect(failed.code).toBe("HOBO_CLI_ERROR");
	});

	it("honours an explicit status and code", () => {
		// A command that knows more than "ok" or "error" — `skipped`, `drifted`,
		// a specific code — must be able to say so, since that is what a script
		// dispatches on.
		const built = envelope({
			ok: false,
			status: "drifted",
			code: "HOBO_DRIFT",
		});
		expect(built.status).toBe("drifted");
		expect(built.code).toBe("HOBO_DRIFT");
	});

	it("lets a successful command carry a non-ok status", () => {
		// `ok` and `status` answer different questions: did the command run, and
		// what did it find. A drift check that ran perfectly and found drift is
		// both.
		const built = envelope({ status: "no-op" });
		expect(built.ok).toBe(true);
		expect(built.status).toBe("no-op");
	});

	it("defaults message and remediation to empty rather than undefined", () => {
		// Both are rendered. `undefined` would print as the string "undefined" in
		// a naive template, and would be omitted entirely from the JSON.
		const built = envelope();
		expect(built.message).toBe("");
		expect(built.remediation).toEqual([]);
	});

	it("carries the command's own data untouched", () => {
		const data = { deploymentId: "dep-1", nested: { ok: true } };
		expect(envelope({ data }).data).toEqual(data);
	});

	it("names the verb it was built for", () => {
		// The verb is how a script correlates an envelope with what it ran, since
		// several may be piped together.
		expect(
			buildEnvelope({ verb: "doctor", context: CONTEXT, result: {} }).verb,
		).toBe("doctor");
	});

	it("projects the context rather than embedding it whole", () => {
		const context = { ...CONTEXT, secretToken: "s3cr3t" };
		const built = buildEnvelope({
			verb: "up",
			context,
			result: {},
		});
		expect(JSON.stringify(built)).not.toContain("s3cr3t");
	});
});

describe("build error remediation", () => {
	function remediation(code: BuildErrorCode, detail: JsonObject = {}) {
		return remediationFor(new BuildError(code, "boom", detail));
	}

	it("tells a drifted codegen to re-run codegen", () => {
		// The single most common build failure, and the fix is one command.
		expect(remediation("HOBO_BUILD_CODEGEN_DRIFT")[0]).toContain(
			"hobo codegen",
		);
	});

	it("tells an empty bindle to declare a service", () => {
		expect(remediation("HOBO_BUILD_NO_SERVICES")[0]).toContain(
			"hobo.bindle.json",
		);
	});

	it("points a usage error at build help", () => {
		expect(remediation("HOBO_BUILD_USAGE")[0]).toContain("hobo build --help");
	});

	it("requires the real toolchain for product builds", () => {
		// Product remediation must not suggest bypassing executable artifact generation.
		const text = remediation("HOBO_BUILD_COMPONENTIZE_TOOLCHAIN")[0] ?? "";
		expect(text).toContain("componentize-js");
		expect(text).toContain("Product builds require real componentization");
		expect(text).not.toContain("unset HOBO_COMPONENTIZE_REAL");
	});

	it("sends a componentize failure to the service source", () => {
		// Distinct from the toolchain case: here the toolchain worked and the
		// user's code did not, so the fix is in their source.
		expect(remediation("HOBO_BUILD_COMPONENTIZE_FAILED")[0]).toContain(
			"service source",
		);
	});

	it("falls back to --json for anything with no specific advice", () => {
		// The only universally-useful next step when nothing more is known:
		// machine-readable detail the user can read or paste.
		for (const code of [
			"HOBO_BUILD_INTERNAL",
			"HOBO_BUILD_PATH_INVALID",
			"HOBO_BUILD_SOURCE_MISSING",
			"HOBO_BUILD_SOURCE_PARSE",
			"HOBO_BUILD_RUNTIME_INVALID",
			"HOBO_BUILD_SERVICE_INVALID",
			"HOBO_BUILD_CODEGEN_FAILED",
		] as const) {
			expect(remediation(code)[0]).toContain("--json");
		}
	});

	it("always returns at least one step", () => {
		// An empty remediation renders as a failure with no way forward.
		for (const code of [
			"HOBO_BUILD_USAGE",
			"HOBO_BUILD_INTERNAL",
			"HOBO_BUILD_CODEGEN_DRIFT",
		] as const) {
			expect(remediation(code).length).toBeGreaterThan(0);
		}
	});
});

describe("BuildError and BuildCliError", () => {
	it("carries a code and detail", () => {
		const error = new BuildError("HOBO_BUILD_INTERNAL", "boom", {
			service: "api",
		});
		expect(error.code).toBe("HOBO_BUILD_INTERNAL");
		expect(error.detail).toEqual({ service: "api" });
		expect(error.name).toBe("BuildError");
	});

	it("defaults detail to an empty object", () => {
		expect(new BuildError("HOBO_BUILD_INTERNAL", "boom").detail).toEqual({});
	});

	it("exits 2 for a usage error and 1 for everything else", () => {
		// Two is the conventional shell exit for misuse, distinct from one for a
		// real failure — a caller scripting the CLI branches on exactly this to
		// tell "I invoked it wrong" from "it ran and failed".
		expect(
			new BuildCliError(new BuildError("HOBO_BUILD_USAGE", "boom")).exitCode,
		).toBe(2);
		expect(
			new BuildCliError(new BuildError("HOBO_BUILD_INTERNAL", "boom")).exitCode,
		).toBe(1);
	});

	it("honours an explicit exit code from the detail", () => {
		// A componentize step that shelled out has a real exit code, and passing
		// it through is what lets a CI script distinguish the tool's own failures.
		expect(
			new BuildCliError(
				new BuildError("HOBO_BUILD_COMPONENTIZE_FAILED", "boom", {
					exitCode: 137,
				}),
			).exitCode,
		).toBe(137);
	});

	it("ignores a non-numeric exit code in the detail", () => {
		// `typeof === "number"`. A string exit code would reach `process.exit`
		// and be coerced to 0 — reporting success for a failed build.
		expect(
			new BuildCliError(
				new BuildError("HOBO_BUILD_INTERNAL", "boom", { exitCode: "137" }),
			).exitCode,
		).toBe(1);
	});

	it("carries the code and remediation onto the CLI error", () => {
		const cliError = new BuildCliError(
			new BuildError("HOBO_BUILD_CODEGEN_DRIFT", "drifted"),
		);
		expect(cliError).toBeInstanceOf(CliError);
		expect(cliError.code).toBe("HOBO_BUILD_CODEGEN_DRIFT");
		expect(cliError.message).toBe("drifted");
		expect(cliError.remediation?.[0]).toContain("hobo codegen");
		expect(cliError.name).toBe("BuildCliError");
	});
});
