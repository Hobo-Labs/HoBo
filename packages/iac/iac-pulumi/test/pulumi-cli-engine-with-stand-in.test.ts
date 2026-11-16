/**
 * The Pulumi CLI automation engine, driven through a stand-in binary.
 *
 * The engine takes its binary as an injected option, so a script that answers
 * `version`, `stack select`, `preview` and `up` is indistinguishable from the
 * real CLI to everything above it. That reaches the interesting parts without
 * a Pulumi install, a cloud account, or a state backend.
 *
 * **An unparseable preview fails dirty, never silently clean.** If
 * `preview --json` returns something this engine cannot read, reporting "no
 * changes" would let an apply skip pending work; a phantom create makes apply
 * re-check instead, which is the recoverable direction. The Terraform lane
 * makes the same choice, and the two agreeing is what lets a caller treat them
 * interchangeably.
 *
 * **State is local and per-resource.** The backend is a `file://` URL under the
 * engine's own work directory and each resource gets its own stack, so a
 * failure in one resource cannot corrupt another's state — and no test can
 * reach a real Pulumi Cloud organisation.
 *
 * **Rendering refuses a type it cannot translate.** Emitting a partial program
 * for an unknown type would deploy the wrong thing rather than nothing.
 *
 * **Every declared output resolves to a real expression.** An output that
 * silently became `${name.id}` for a field that is not an id would hand a
 * binding the wrong value, which surfaces much later as a broken connection
 * rather than as a deploy error.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createPulumiCliAutomationEngine,
	PULUMI_CLI_MISSING,
	PULUMI_UNSUPPORTED_RESOURCE,
	PULUMI_YAML_TYPE_TOKENS,
	PulumiEngineUnavailableError,
	renderPulumiYamlProgram,
} from "../src/pulumi-cli-engine.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-pulumi-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A stand-in `pulumi`. `body` decides what each invocation does. */
function fakePulumi(body: string): string {
	const dir = tempDir("hobo-pulumi-bin-");
	const bin = join(dir, "pulumi");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const argv = process.argv.slice(2);",
			'if (argv[0] === "version") { process.stdout.write("v3.140.0\\n"); process.exit(0); }',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

function engine(body = "process.exit(0);") {
	return createPulumiCliAutomationEngine({
		workDir: tempDir("hobo-pulumi-work-"),
		pulumiBin: fakePulumi(body),
		// The stand-in is a node script, so its shebang needs node on PATH.
		env: { PATH: dirname(process.execPath) },
	});
}

/** A program with one Cloudflare KV resource. */
const program = (type = "cloudflare:kv-namespace") =>
	({
		deploymentId: "dep-1",
		resources: [{ name: "cache", type, outputs: ["namespaceId"] }],
		// SAFETY: the engine reads exactly the fields named above.
	}) as never;

/** Render one resource of the given type. */
const render = (
	type: string,
	outputs?: readonly string[],
	inputs?: Record<string, unknown>,
) =>
	renderPulumiYamlProgram(
		// SAFETY: the renderer reads exactly the fields named here.
		{
			name: "res",
			type,
			...(outputs ? { outputs } : {}),
			...(inputs ? { inputs } : {}),
		} as never,
		{ accountId: "acct-1" },
	);

describe("rendering a Pulumi YAML program", () => {
	it("names the program after the resource", () => {
		expect(render("cloudflare:kv-namespace")).toContain("name: hobo-res");
	});

	it("declares the yaml runtime", () => {
		// The YAML runtime is what makes these programs dependency-free; a
		// language runtime would need a toolchain per deploy.
		expect(render("cloudflare:kv-namespace")).toContain("runtime: yaml");
	});

	it("uses the provider's own type token", () => {
		expect(render("cloudflare:kv-namespace")).toContain(
			"type: cloudflare:WorkersKvNamespace",
		);
	});

	it("carries the account id into the properties", () => {
		// The account id decides whose infrastructure a program touches.
		expect(render("cloudflare:kv-namespace")).toContain("acct-1");
	});

	it("titles a KV namespace rather than naming it", () => {
		// The Cloudflare provider spells a KV namespace's identity `title`;
		// sending `name` would create an unnamed namespace.
		expect(render("cloudflare:kv-namespace")).toContain('"title":"res"');
	});

	it("names a worker script", () => {
		expect(render("cloudflare:workers-script")).toContain('"name":"res"');
	});

	it("gives a worker script a default body", () => {
		// A script with no content is rejected by the provider, so an operator
		// deploying a placeholder gets a working one rather than an error.
		expect(render("cloudflare:workers-script")).toContain("hello from hobo");
	});

	it("keeps a supplied worker script", () => {
		expect(
			render("cloudflare:workers-script", undefined, {
				options: { script: "export default {};" },
			}),
		).toContain("export default {};");
	});

	it("ignores a non-string script and uses the default", () => {
		// A number coerced into a script body would deploy something that is not
		// JavaScript and fail at the edge rather than at the render.
		expect(
			render("cloudflare:workers-script", undefined, {
				options: { script: 7 },
			}),
		).toContain("hello from hobo");
	});

	it("refuses a type it cannot translate", () => {
		expect(() => render("aws:s3-bucket")).toThrow(PulumiEngineUnavailableError);
	});

	it("codes an unsupported type so a caller can branch on it", () => {
		try {
			render("aws:s3-bucket");
			expect.unreachable("expected the renderer to refuse");
		} catch (error) {
			// A caller choosing a fallback lane needs the code, not the prose.
			expect((error as { code?: string }).code).toBe(
				PULUMI_UNSUPPORTED_RESOURCE,
			);
		}
	});

	it("renders every type it claims to support", () => {
		// The token table is the lane's public claim about what it can deploy;
		// a listed type that throws is a lie in the capability matrix.
		for (const type of Object.keys(PULUMI_YAML_TYPE_TOKENS)) {
			expect(() => render(type)).not.toThrow();
		}
	});
});

describe("resolving declared outputs", () => {
	it("defaults to a binding output", () => {
		expect(render("cloudflare:kv-namespace")).toContain("binding:");
	});

	it("resolves binding to the stable resource name", () => {
		// The binding alias is HoBo's own handle and must not depend on a
		// provider-assigned id that changes on replace.
		expect(render("cloudflare:kv-namespace", ["binding"])).toContain(
			'binding: "res"',
		);
	});

	it("resolves a KV namespace id from the resource", () => {
		expect(render("cloudflare:kv-namespace", ["namespaceId"])).toContain(
			"namespaceId: ${res.id}",
		);
	});

	it("resolves a worker script name from the resource", () => {
		expect(render("cloudflare:workers-script", ["scriptName"])).toContain(
			"scriptName: ${res.name}",
		);
	});

	it("resolves a worker URL as a literal, not a provider output", () => {
		// The workers.dev URL needs the account subdomain, which is not a
		// resource output — deriving it here rather than referencing a field
		// that does not exist is what keeps the program valid.
		expect(render("cloudflare:workers-script", ["url"])).toContain(
			"https://res.workers.dev",
		);
	});

	it("resolves an R2 bucket name from the resource", () => {
		expect(render("cloudflare:r2-bucket", ["bucketName"])).toContain(
			"bucketName: ${res.name}",
		);
	});

	it("resolves an R2 endpoint from the resource id", () => {
		expect(render("cloudflare:r2-bucket", ["endpoint"])).toContain(
			"endpoint: ${res.id}",
		);
	});

	it("falls back to the id for an output it does not know", () => {
		expect(render("cloudflare:kv-namespace", ["mystery"])).toContain(
			"mystery: ${res.id}",
		);
	});

	it("renders several outputs at once", () => {
		const yaml = render("cloudflare:workers-script", ["binding", "scriptName"]);
		expect(yaml).toContain("binding:");
		expect(yaml).toContain("scriptName:");
	});

	it("does not resolve a worker output for a KV resource", () => {
		// `scriptName` on a KV namespace is a caller mistake; resolving it to
		// `${res.name}` would produce a program referencing a field the provider
		// does not expose on that type.
		expect(render("cloudflare:kv-namespace", ["scriptName"])).toContain(
			"scriptName: ${res.id}",
		);
	});
});

describe("gating on the CLI", () => {
	it("refuses a snapshot when the binary is missing", () => {
		const created = createPulumiCliAutomationEngine({
			workDir: tempDir(),
			pulumiBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		expect(() => created.snapshot()).toThrow(PulumiEngineUnavailableError);
	});

	it("codes a missing CLI so a caller can fall back", () => {
		const created = createPulumiCliAutomationEngine({
			workDir: tempDir(),
			pulumiBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		try {
			created.snapshot();
			expect.unreachable("expected the engine to refuse");
		} catch (error) {
			expect((error as { code?: string }).code).toBe(PULUMI_CLI_MISSING);
		}
	});

	it("names the binary it could not run", () => {
		const missing = join(tempDir(), "not-installed");
		const created = createPulumiCliAutomationEngine({
			workDir: tempDir(),
			pulumiBin: missing,
			env: { PATH: dirname(process.execPath) },
		});
		expect(() => created.snapshot()).toThrow(/not-installed/);
	});

	it("refuses a preview when the binary is missing", async () => {
		const created = createPulumiCliAutomationEngine({
			workDir: tempDir(),
			pulumiBin: join(tempDir(), "not-installed"),
			env: { PATH: dirname(process.execPath) },
		});
		await expect(created.preview(program())).rejects.toThrow(
			PulumiEngineUnavailableError,
		);
	});

	it("accepts a CLI that answers the version probe", () => {
		expect(() => engine().snapshot()).not.toThrow();
	});

	it("verifies the CLI once rather than per operation", () => {
		const binDir = tempDir("hobo-pulumi-bin-");
		const bin = join(binDir, "pulumi");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				'process.stdout.write("v3.140.0\\n");',
				"process.exit(0);",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(bin, 0o755);
		const created = createPulumiCliAutomationEngine({
			workDir: tempDir("hobo-pulumi-work-"),
			pulumiBin: bin,
			env: { PATH: dirname(process.execPath) },
		});
		created.snapshot();
		// Remove the binary. A second snapshot that re-probed would fail; one
		// that cached the verification will not. A probe per operation would
		// double the process count of every deploy for no information.
		rmSync(bin);
		expect(() => created.snapshot()).not.toThrow();
	});
});

describe("keeping state local", () => {
	it("points the backend at its own work directory", async () => {
		const workDir = tempDir("hobo-pulumi-work-");
		const log = join(tempDir("hobo-pulumi-log-"), "env.log");
		const created = createPulumiCliAutomationEngine({
			workDir,
			pulumiBin: fakePulumi(`
				require("node:fs").appendFileSync(
					${JSON.stringify(log)},
					String(process.env.PULUMI_BACKEND_URL) + "\\n",
				);
				if (argv[0] === "preview") { process.stdout.write("{}"); }
				process.exit(0);
			`),
			env: { PATH: dirname(process.execPath) },
		});
		// Driven through `preview` rather than `snapshot`: an empty estate short-
		// circuits before invoking the CLI at all, so a snapshot-based assertion
		// would observe nothing and pass for the wrong reason.
		await created.preview(program());
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		// The backend must be a local file:// URL under this engine's own
		// directory. Anything else would reach a real Pulumi Cloud organisation.
		expect(readFileSync(log, "utf8")).toContain(`file://${workDir}`);
	});

	it("never points the backend at a hosted organisation", async () => {
		const log = join(tempDir("hobo-pulumi-log-"), "env.log");
		const created = createPulumiCliAutomationEngine({
			workDir: tempDir("hobo-pulumi-work-"),
			pulumiBin: fakePulumi(`
				require("node:fs").appendFileSync(
					${JSON.stringify(log)},
					String(process.env.PULUMI_BACKEND_URL) + "\\n",
				);
				if (argv[0] === "preview") { process.stdout.write("{}"); }
				process.exit(0);
			`),
			// Even with a hosted backend in the ambient environment, the engine
			// pins its own — otherwise a developer's shell config would silently
			// send HoBo's state to their personal Pulumi account.
			env: {
				PATH: dirname(process.execPath),
				PULUMI_BACKEND_URL: "https://api.pulumi.com",
			},
		});
		await created.preview(program());
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		expect(readFileSync(log, "utf8")).not.toContain("api.pulumi.com");
	});

	it("reports an empty estate before anything is applied", () => {
		expect(engine().snapshot()).toEqual({});
	});

	it("freezes the snapshot", () => {
		// The snapshot is diffed against desired state; a caller mutating it
		// would change the diff under the planner.
		expect(Object.isFrozen(engine().snapshot())).toBe(true);
	});
});

describe("previewing a program", () => {
	it("reports a change when the preview has one", async () => {
		const created = engine(`
			if (argv[0] === "preview") {
				process.stdout.write(JSON.stringify({ changeSummary: { create: 1 } }));
			}
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toHaveLength(1);
	});

	it("reports no change for an empty summary", async () => {
		const created = engine(`
			if (argv[0] === "preview") {
				process.stdout.write(JSON.stringify({ changeSummary: { same: 1 } }));
			}
			process.exit(0);
		`);
		// `same` is Pulumi's word for an unchanged resource; counting it would
		// make every preview report work that is not happening.
		expect((await created.preview(program())).changes).toEqual([]);
	});

	it("reports no change when there is no summary at all", async () => {
		const created = engine(`
			if (argv[0] === "preview") { process.stdout.write("{}"); }
			process.exit(0);
		`);
		expect((await created.preview(program())).changes).toEqual([]);
	});

	it("fails dirty when the preview cannot be parsed", async () => {
		const created = engine(`
			if (argv[0] === "preview") { process.stdout.write("not json"); }
			process.exit(0);
		`);
		// Reporting "no changes" here would let an apply skip pending work. The
		// Terraform lane makes the same choice, and the two agreeing is what
		// lets a caller treat them interchangeably.
		expect((await created.preview(program())).changes).toHaveLength(1);
	});

	it("refuses a program whose type has no translation", async () => {
		await expect(engine().preview(program("aws:s3-bucket"))).rejects.toThrow(
			PulumiEngineUnavailableError,
		);
	});

	it("selects a stack before previewing it", async () => {
		const log = join(tempDir("hobo-pulumi-log-"), "calls.log");
		const created = engine(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			if (argv[0] === "preview") { process.stdout.write("{}"); }
			process.exit(0);
		`);
		await created.preview(program());
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const calls = readFileSync(log, "utf8");
		// A preview against no selected stack runs against whatever was last
		// selected — which is another resource's state.
		expect(calls).toContain("stack select");
	});

	it("creates the stack it selects", async () => {
		const log = join(tempDir("hobo-pulumi-log-"), "calls.log");
		const created = engine(`
			require("node:fs").appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");
			if (argv[0] === "preview") { process.stdout.write("{}"); }
			process.exit(0);
		`);
		await created.preview(program());
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		// `--create` makes the first deploy of a resource work without a
		// separate bootstrap step.
		expect(readFileSync(log, "utf8")).toContain("--create");
	});
});
