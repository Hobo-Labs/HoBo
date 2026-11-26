/**
 * The Terraform/OpenTofu CLI engine, driven through a stand-in binary.
 *
 * This lane is normally gated on a real `tofu` or `terraform` install, but the
 * binary is an injected option rather than a hard-coded name — so a script on
 * disk that answers `version`, `init`, `plan`, `show`, `apply` and `destroy` is
 * indistinguishable from the real thing to everything above it. That reaches
 * the parts worth pinning without provisioning any cloud resource.
 *
 * **An unparseable plan fails dirty, never silently clean.** If `show -json`
 * returns something this engine cannot read, reporting "no changes" would let
 * an apply skip work that was actually pending. Reporting a change instead
 * makes apply re-check, which is the recoverable direction.
 *
 * **A missing binary is a named error, not a stack trace.** The lane is
 * optional; an operator without OpenTofu installed needs to be told that,
 * rather than seeing an ENOENT from deep inside a plan.
 *
 * **A resource type with no translation is refused up front.** Rendering a
 * partial program for an unknown type would produce HCL that applies
 * *something* — the wrong something — instead of refusing.
 *
 * **Workspace keys are sanitised into single path segments.** Each resource
 * gets its own workspace holding its own state file; a key that escaped its
 * directory would put one resource's state on top of another's.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createTerraformCliEngine,
	parsePlanChanges,
	renderTerraformJsonProgram,
	TERRAFORM_TYPE_TOKENS,
	TerraformEngineUnavailableError,
} from "../src/terraform-cli-engine.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-tf-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/**
 * A stand-in `tofu`. `body` decides what each invocation does; `argv[0]` is
 * the subcommand, so a script can answer `version` and then script `plan` and
 * `show` however the test needs.
 */
function fakeTofu(body: string): string {
	const dir = tempDir("hobo-tf-bin-");
	const bin = join(dir, "tofu");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const argv = process.argv.slice(2);",
			'if (argv[0] === "version") { process.stdout.write("OpenTofu v1.8.0\\n"); process.exit(0); }',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

function engine(body = "process.exit(0);") {
	return createTerraformCliEngine({
		workDir: tempDir("hobo-tf-work-"),
		binary: fakeTofu(body),
		// The stand-in is a node script, so its shebang needs node on PATH.
		env: { PATH: dirname(process.execPath) },
	});
}

/** A program with one trivial-greeting resource. */
const program = (type = "hobo:trivial/greeting") =>
	({
		name: "demo",
		resources: [{ name: "hello", type, outputs: ["greeting"] }],
		// SAFETY: the engine reads exactly the fields named above.
	}) as never;

describe("reading a plan summary", () => {
	it("counts a create", () => {
		expect(
			parsePlanChanges(
				JSON.stringify({
					resource_changes: [{ change: { actions: ["create"] } }],
				}),
			),
		).toEqual({ create: 1, update: 0, delete: 0 });
	});

	it("counts an update", () => {
		expect(
			parsePlanChanges(
				JSON.stringify({
					resource_changes: [{ change: { actions: ["update"] } }],
				}),
			).update,
		).toBe(1);
	});

	it("counts a delete", () => {
		expect(
			parsePlanChanges(
				JSON.stringify({
					resource_changes: [{ change: { actions: ["delete"] } }],
				}),
			).delete,
		).toBe(1);
	});

	it("counts a replace as both a delete and a create", () => {
		// Terraform spells a replacement as two actions on one change. Counting
		// it as one would under-report what the apply is about to do.
		const summary = parsePlanChanges(
			JSON.stringify({
				resource_changes: [{ change: { actions: ["delete", "create"] } }],
			}),
		);
		expect(summary).toMatchObject({ create: 1, delete: 1 });
	});

	it("reports nothing for a plan with no changes", () => {
		expect(parsePlanChanges(JSON.stringify({ resource_changes: [] }))).toEqual({
			create: 0,
			update: 0,
			delete: 0,
		});
	});

	it("reports nothing for a plan with no resource_changes key", () => {
		expect(parsePlanChanges("{}")).toEqual({
			create: 0,
			update: 0,
			delete: 0,
		});
	});

	it("ignores a change with no actions", () => {
		expect(
			parsePlanChanges(JSON.stringify({ resource_changes: [{}] })),
		).toEqual({ create: 0, update: 0, delete: 0 });
	});

	it("ignores a no-op action", () => {
		expect(
			parsePlanChanges(
				JSON.stringify({
					resource_changes: [{ change: { actions: ["no-op"] } }],
				}),
			),
		).toEqual({ create: 0, update: 0, delete: 0 });
	});

	it("fails dirty on unparseable output", () => {
		// Reporting "no changes" here would let an apply skip work that was
		// actually pending. A phantom create makes apply re-check instead, which
		// is the recoverable direction.
		expect(parsePlanChanges("not json")).toEqual({
			create: 1,
			update: 0,
			delete: 0,
		});
	});

	it("fails dirty on empty output", () => {
		expect(parsePlanChanges("").create).toBe(1);
	});
});

describe("rendering a resource to HCL JSON", () => {
	it("renders the trivial greeting as terraform_data", () => {
		const doc = renderTerraformJsonProgram(
			// SAFETY: the renderer reads exactly the fields named here.
			{ name: "hello", type: "hobo:trivial/greeting" } as never,
			{ accountId: "acct" },
		);
		expect(doc.resource).toMatchObject({ terraform_data: { hello: {} } });
	});

	it("defaults the greeting message from the resource name", () => {
		const doc = renderTerraformJsonProgram(
			{ name: "hello", type: "hobo:trivial/greeting" } as never,
			{ accountId: "acct" },
		);
		// SAFETY: the shape asserted immediately above.
		const input = (doc.resource as never as Record<string, never>)
			.terraform_data.hello.input;
		expect(input).toMatchObject({ message: "hello-hello" });
	});

	it("keeps an explicit greeting message", () => {
		const doc = renderTerraformJsonProgram(
			{
				name: "hello",
				type: "hobo:trivial/greeting",
				inputs: { message: "custom" },
			} as never,
			{ accountId: "acct" },
		);
		const input = (doc.resource as never as Record<string, never>)
			.terraform_data.hello.input;
		expect(input).toMatchObject({ message: "custom" });
	});

	it("pins the cloudflare provider for a cloudflare resource", () => {
		const doc = renderTerraformJsonProgram(
			{ name: "kv", type: "cloudflare:kv-namespace" } as never,
			{ accountId: "acct" },
		);
		// An unpinned provider would let a fresh init pull a major version that
		// renames arguments, turning a working program into a plan error.
		expect(doc.terraform).toMatchObject({
			required_providers: { cloudflare: { version: "~> 4.0" } },
		});
	});

	it("carries the account id into a cloudflare resource", () => {
		const doc = renderTerraformJsonProgram(
			{ name: "kv", type: "cloudflare:kv-namespace" } as never,
			{ accountId: "acct-1234" },
		);
		// The account id decides *whose* infrastructure this touches.
		expect(JSON.stringify(doc)).toContain("acct-1234");
	});

	it("refuses a resource type it cannot translate", () => {
		// Rendering a partial program for an unknown type would apply the wrong
		// something rather than refusing.
		expect(() =>
			renderTerraformJsonProgram(
				{ name: "x", type: "aws:s3-bucket" } as never,
				{ accountId: "acct" },
			),
		).toThrow(TerraformEngineUnavailableError);
	});

	it("names the unsupported type in the refusal", () => {
		expect(() =>
			renderTerraformJsonProgram(
				{ name: "x", type: "aws:s3-bucket" } as never,
				{ accountId: "acct" },
			),
		).toThrow(/aws:s3-bucket/);
	});

	it("renders every type it claims to support", () => {
		// The token table is the lane's public claim about what it can deploy.
		// A type listed there that throws on render is a lie in the matrix.
		for (const type of Object.keys(TERRAFORM_TYPE_TOKENS)) {
			expect(() =>
				renderTerraformJsonProgram({ name: "r", type } as never, {
					accountId: "acct",
				}),
			).not.toThrow();
		}
	});
});

describe("the engine's identity", () => {
	it("defaults to tofu", () => {
		const created = createTerraformCliEngine({ workDir: tempDir() });
		// OpenTofu is the documented default backend; silently preferring
		// terraform would change which licence a deploy runs under.
		expect(created.binary).toBe("tofu");
	});

	it("reports the pinned tofu version by default", () => {
		expect(
			createTerraformCliEngine({ workDir: tempDir() }).toolchainVersion,
		).toMatch(/^\d/);
	});

	it("reports a different pinned version for terraform", () => {
		const tofu = createTerraformCliEngine({ workDir: tempDir() });
		const terraform = createTerraformCliEngine({
			workDir: tempDir(),
			binary: "terraform",
		});
		// The two toolchains diverge; reporting one version for both would make
		// a receipt claim a toolchain that never ran.
		expect(terraform.toolchainVersion).not.toBe(tofu.toolchainVersion);
	});

	it("keeps an explicit binary path", () => {
		const bin = fakeTofu("process.exit(0);");
		expect(
			createTerraformCliEngine({ workDir: tempDir(), binary: bin }).binary,
		).toBe(bin);
	});
});

describe("gating on the binary", () => {
	it("refuses a snapshot when the binary is missing", () => {
		const created = createTerraformCliEngine({
			workDir: tempDir(),
			binary: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		// The lane is optional. An operator without OpenTofu needs to be told
		// that, not shown an ENOENT from inside a plan.
		expect(() => created.snapshot()).toThrow(TerraformEngineUnavailableError);
	});

	it("names the binary it could not run", () => {
		const missing = join(tempDir(), "not-installed");
		const created = createTerraformCliEngine({
			workDir: tempDir(),
			binary: missing,
			env: { PATH: dirname(process.execPath) },
		});
		expect(() => created.snapshot()).toThrow(/not-installed/);
	});

	it("refuses a preview when the binary is missing", async () => {
		const created = createTerraformCliEngine({
			workDir: tempDir(),
			binary: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		await expect(created.preview(program())).rejects.toThrow(
			TerraformEngineUnavailableError,
		);
	});

	it("accepts a binary that answers the version probe", () => {
		expect(() => engine().snapshot()).not.toThrow();
	});

	it("probes the binary only once", () => {
		const binDir = tempDir("hobo-tf-bin-");
		const bin = join(binDir, "tofu");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				'process.stdout.write("OpenTofu v1.8.0\\n");',
				"process.exit(0);",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(bin, 0o755);
		const created = createTerraformCliEngine({
			workDir: tempDir("hobo-tf-work-"),
			binary: bin,
			env: { PATH: dirname(process.execPath) },
		});
		created.snapshot();
		// Delete the binary out from under the engine. A second snapshot that
		// re-probed would now fail; one that cached the first verification will
		// not. A version probe per operation would double the process count of
		// every deploy for no information.
		rmSync(bin);
		expect(() => created.snapshot()).not.toThrow();
	});
});

describe("snapshotting the estate", () => {
	it("reports an empty estate before anything is applied", () => {
		expect(engine().snapshot()).toEqual({});
	});

	it("freezes the snapshot", () => {
		// The snapshot is compared against desired state; a caller mutating it
		// would change the diff under the planner.
		expect(Object.isFrozen(engine().snapshot())).toBe(true);
	});
});

describe("previewing a program", () => {
	it("reports a change when the plan has one", async () => {
		const created = engine(`
			if (argv[0] === "show") {
				process.stdout.write(JSON.stringify({
					resource_changes: [{ change: { actions: ["create"] } }],
				}));
			}
			process.exit(0);
		`);
		const preview = await created.preview(program());
		expect(preview.changes).toHaveLength(1);
	});

	it("reports no change when the plan is empty", async () => {
		const created = engine(`
			if (argv[0] === "show") { process.stdout.write('{"resource_changes":[]}'); }
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toEqual([]);
	});

	it("calls the change a create when the plan creates", async () => {
		const created = engine(`
			if (argv[0] === "show") {
				process.stdout.write(JSON.stringify({
					resource_changes: [{ change: { actions: ["create"] } }],
				}));
			}
			process.exit(0);
		`);
		const preview = await created.preview(program());
		expect(preview.changes[0]).toMatchObject({ op: "create" });
	});

	it("calls the change a delete when the plan only deletes", async () => {
		const created = engine(`
			if (argv[0] === "show") {
				process.stdout.write(JSON.stringify({
					resource_changes: [{ change: { actions: ["delete"] } }],
				}));
			}
			process.exit(0);
		`);
		// Only when nothing is created or updated — a replace is a create, since
		// the resource exists afterwards.
		expect((await created.preview(program())).changes[0]).toMatchObject({
			op: "delete",
		});
	});

	it("calls a replace a create rather than a delete", async () => {
		const created = engine(`
			if (argv[0] === "show") {
				process.stdout.write(JSON.stringify({
					resource_changes: [{ change: { actions: ["delete", "create"] } }],
				}));
			}
			process.exit(0);
		`);
		// The resource exists after a replace, so calling it a delete would tell
		// an operator their resource is going away.
		expect((await created.preview(program())).changes[0]).toMatchObject({
			op: "create",
		});
	});

	it("attributes the change to its resource", async () => {
		const created = engine(`
			if (argv[0] === "show") {
				process.stdout.write(JSON.stringify({
					resource_changes: [{ change: { actions: ["create"] } }],
				}));
			}
			process.exit(0);
		`);
		expect((await created.preview(program())).changes[0]).toMatchObject({
			resource: "hello",
		});
	});

	it("says the plan is the reason", async () => {
		const created = engine(`
			if (argv[0] === "show") {
				process.stdout.write(JSON.stringify({
					resource_changes: [{ change: { actions: ["create"] } }],
				}));
			}
			process.exit(0);
		`);
		// A receipt has to say what decided the change; "terraform-plan" is what
		// distinguishes it from a drift-derived or forced one.
		expect((await created.preview(program())).changes[0]).toMatchObject({
			reason: "terraform-plan",
		});
	});

	it("refuses a program whose resource type has no translation", async () => {
		await expect(engine().preview(program("aws:s3-bucket"))).rejects.toThrow(
			TerraformEngineUnavailableError,
		);
	});

	it("initialises a workspace before planning it", async () => {
		const log = join(tempDir("hobo-tf-log-"), "calls.log");
		const created = engine(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv[0] + "\\n");
			if (argv[0] === "show") { process.stdout.write('{"resource_changes":[]}'); }
			process.exit(0);
		`);
		await created.preview(program());
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
		// A plan against an uninitialised workspace fails on a missing provider,
		// which reads as a program error rather than a setup one.
		expect(calls.indexOf("init")).toBeLessThan(calls.indexOf("plan"));
	});
});
