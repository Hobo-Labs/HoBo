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
		const names = CANONICAL_VERBS.map((verb) => verb.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("gives every verb a role and a summary", () => {
		for (const verb of CANONICAL_VERBS) {
			expect(verb.name.length).toBeGreaterThan(0);
			expect(verb.role.length).toBeGreaterThan(0);
			expect(verb.summary.length).toBeGreaterThan(0);
		}
	});

	it("derives the name set from the catalog", () => {
		expect(verbNames.size).toBe(CANONICAL_VERBS.length);
		for (const verb of CANONICAL_VERBS) {
			expect(verbNames.has(verb.name)).toBe(true);
		}
	});

	it("excludes the verbs that legitimately run outside a project", () => {
		for (const verb of ["new", "doctor", "login", "claim"]) {
			expect(projectScopedVerbs.has(verb)).toBe(false);
		}
	});

	it("scopes the lifecycle verbs to a project", () => {
		for (const verb of ["up", "down", "dev"]) {
			expect(projectScopedVerbs.has(verb)).toBe(true);
		}
	});

	it("only lists real verbs as project-scoped", () => {
		for (const verb of projectScopedVerbs) {
			expect(verbNames.has(verb)).toBe(true);
		}
	});
});

describe("help text", () => {
	it("lists every canonical verb", () => {
		const text = helpText();
		for (const verb of CANONICAL_VERBS) {
			expect(text).toContain(verb.name);
		}
	});

	it("documents every global flag", () => {
		const text = helpText();
		for (const flag of GLOBAL_FLAGS) {
			const name = flag.split(" ")[0] ?? flag;
			expect(text).toContain(name);
		}
	});

	it("opens with a concrete first-run path", () => {
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
		expect(() => verbHelpText("nope")).toThrow(/unknown verb/u);
	});

	it("says nothing about implementation status when not told", () => {
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
		expect(
			publicContext({ ...CONTEXT, identity: undefined } as never).identity,
		).toBeNull();
	});

	it("keeps a null project directory as null", () => {
		expect(
			publicContext({ ...CONTEXT, projectDir: null }).projectDir,
		).toBeNull();
	});

	it("rebuilds the object rather than passing the caller's through", () => {
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
		const built = envelope({
			ok: false,
			status: "drifted",
			code: "HOBO_DRIFT",
		});
		expect(built.status).toBe("drifted");
		expect(built.code).toBe("HOBO_DRIFT");
	});

	it("lets a successful command carry a non-ok status", () => {
		const built = envelope({ status: "no-op" });
		expect(built.ok).toBe(true);
		expect(built.status).toBe("no-op");
	});

	it("defaults message and remediation to empty rather than undefined", () => {
		const built = envelope();
		expect(built.message).toBe("");
		expect(built.remediation).toEqual([]);
	});

	it("carries the command's own data untouched", () => {
		const data = { deploymentId: "dep-1", nested: { ok: true } };
		expect(envelope({ data }).data).toEqual(data);
	});

	it("names the verb it was built for", () => {
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
		const text = remediation("HOBO_BUILD_COMPONENTIZE_TOOLCHAIN")[0] ?? "";
		expect(text).toContain("componentize-js");
		expect(text).toContain("Product builds require real componentization");
		expect(text).not.toContain("unset HOBO_COMPONENTIZE_REAL");
	});

	it("sends a componentize failure to the service source", () => {
		expect(remediation("HOBO_BUILD_COMPONENTIZE_FAILED")[0]).toContain(
			"service source",
		);
	});

	it("falls back to --json for anything with no specific advice", () => {
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
		expect(
			new BuildCliError(new BuildError("HOBO_BUILD_USAGE", "boom")).exitCode,
		).toBe(2);
		expect(
			new BuildCliError(new BuildError("HOBO_BUILD_INTERNAL", "boom")).exitCode,
		).toBe(1);
	});

	it("honours an explicit exit code from the detail", () => {
		expect(
			new BuildCliError(
				new BuildError("HOBO_BUILD_COMPONENTIZE_FAILED", "boom", {
					exitCode: 137,
				}),
			).exitCode,
		).toBe(137);
	});

	it("ignores a non-numeric exit code in the detail", () => {
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
