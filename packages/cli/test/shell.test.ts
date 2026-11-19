import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	CANONICAL_VERBS,
	createHoboCli,
	helpText,
	runHobo,
} from "../src/index.js";
import { parseJsonObject } from "../src/json.js";
import type { CliContext } from "../src/types/envelope.js";

const canonicalVerbNames = [
	"up",
	"down",
	"dev",
	"new",
	"login",
	"connection",
	"identity",
	"trails",
	"access",
	"feature",
	"deploy",
	"ci",
	"cd",
	"incident",
	"claim",
	"recipes",
	"offer",
	"plan",
	"verify",
	"can-deploy",
	"inspect",
	"logs",
	"doctor",
	"messaging",
	"codegen",
	"build",
	"collect",
	"stub",
	"drift",
	"add",
	"registry",
	"import",
	"generate",
	"sandbox",
	"test",
	"attest",
	"erase",
	"broker",
	"yard",
	"station",
	"serve",
	"replay",
	"derivative",
	"runbook",
];

const globalFlags = [
	"--json",
	"--camp <camp>",
	"--cwd <path>",
	"--verbose",
	"-q",
	"--help",
];

const goldenHelp = `HoBo CLI

Usage:
  hobo [global flags] <verb> [args]
  hobo --help
  hobo <verb> --help

Start here:
  hobo doctor             Check local readiness and next steps
  hobo new my-app -t api  Scaffold an offline app
  cd my-app && hobo dev --once

Global flags:
  --json          Emit a machine-readable JSON envelope on stdout
  --camp <camp>   Select the target Camp
  --cwd <path>    Resolve the HoBo project from this directory
  --verbose       Print detailed diagnostics on stderr
  -q              Suppress non-error human output
  --help          Show help

Canonical verbs:
  up          lifecycle     Realize the current object graph
  down        lifecycle     Tear down what up realized
  dev         local loop    Run against runtime-local
  new         local loop    Scaffold a runnable SDK program
  login       identity      Obtain a dev SVID through OIDC
  connection  identity      Manage durable Connections (create/authorize/list/get/revoke/rotate)
  identity    identity      Inspect migration identity (status/inspect) or manage auth.md agents (agent discover/register/status/claim/poll/token/rotate/revoke)
  trails      migration     Observe Trails status/plan/inspect (continuous migration; identity hands-off)
  access      identity      Request elevated/cross-env access or break-glass (short-lived capability; audited)
  feature     delivery      OpenFeature flags / canary / experiment status (list|eval|set|kill)
  deploy      delivery      Attested continuous delivery status/logs/rollback (secret-free)
  ci          delivery      Connect a repository and inspect CI runs (connect/list/inspect); up/down/plan/status converge the CI project
  cd          delivery      Converge the CD project (up/down/plan/status) and its provider connections; other subcommands are hobo deploy
  incident    delivery      CD failure disposition: A2H handoff or sandboxed self-heal
  claim       identity      Bind an anonymous deployment to an account
  recipes     read-only     List and inspect deployment recipes and their claim terms
  offer       read-only     Compile a deployment offer and its consent requirements
  plan        read-only     Dry-run the up decision
  verify      read-only     Run the unified Gatekeeper preflight
  can-deploy  read-only     Diagnose producer/consumer compatibility
  inspect     read-only     Render projections and time-travel views
  logs        read-only     Read or follow local deployment logs
  doctor      diagnostics   Report environment and portability hazards
  messaging   diagnostics   Inspect messaging capability and delivery-guarantee readiness
  codegen     authoring     Regenerate checked-in generated clients
  build       authoring     Compile services to wasm components
  collect     authoring     Run resource collection and print manifest IR
  stub        authoring     Run with a contract-backed stub
  drift       diagnostics   Report drift and governed remediation paths
  add         distribution  Install a provider or listing
  registry    distribution  Administer registry artifacts
  import      migration     Adopt existing estate in place
  generate    generation    Request provider generation
  sandbox     test loop     Run a contract-backed isolated lane
  test        test loop     Alias for the sandbox test lane
  attest      governance    Produce signed external evidence exports
  erase       governance    Request crypto-shred erasure
  broker      governance    Resolve placements through the broker (the Conductor)
  yard        control plane Install and inspect the default bare-metal Yard
  station     control plane Station occupancy setup/ops (init/up/status/rails); not a lifecycle verb
  serve       control plane Serve the local control-plane HTTP and SSE API
  replay      observability Session Replay list/get/open/summarize/retention/doctor (privacy-first; distinct from event-log replay)
  derivative  extensibility Manage derived HoBo implementations
  runbook     SRE           Execute or replay incident runbooks
`;

async function withBindle(callback: (cwd: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-shell-"));
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		JSON.stringify({ name: "snapshop" }),
	);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withEmptyDir(callback: (cwd: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-empty-"));
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("HoBo CLI shell", () => {
	it("pins hobo --help to the canonical HOBO-8 verbs and global flags", async () => {
		expect(CANONICAL_VERBS.map((verb) => verb.name)).toEqual(
			canonicalVerbNames,
		);

		const result = await runHobo(["--help"], { cwd: process.cwd() });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(goldenHelp);
		expect(result.stderr).toBe("");
		expect(helpText()).toBe(goldenHelp);

		const verbHelp = await runHobo(["plan", "--help"], { cwd: process.cwd() });
		expect(verbHelp.exitCode).toBe(0);
		expect(verbHelp.stdout).toMatch(/Usage:\n {2}hobo plan \[global flags\]/);
		expect(verbHelp.stdout).toMatch(/Status: not yet implemented/);
		expect(verbHelp.stdout).toMatch(/Example:\n {2}hobo plan --json/);

		const upHelp = await runHobo(["up", "--help"], { cwd: process.cwd() });
		for (const flag of ["--to", "--rollback", "--anonymous", "--broker"]) {
			expect(upHelp.stdout).toContain(flag);
		}
		expect(upHelp.stdout).toMatch(/Example:/);

		for (const flag of globalFlags) {
			expect(result.stdout).toMatch(new RegExp(flag.replace(/[<>]/g, "\\$&")));
		}
		for (const retired of [
			"destroy",
			"teardown",
			"rollback",
			"promote",
			"forge",
			"train",
			"crew",
			"fleet",
		]) {
			expect(result.stdout).not.toMatch(new RegExp(`^  ${retired}\\s`, "m"));
		}
	});

	it("emits a failing JSON stub envelope for hobo plan --json", async () => {
		await withBindle(async (cwd) => {
			const result = await runHobo(["plan", "--json"], { cwd });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toMatch(/not yet implemented\nUsage:/);

			const envelope = parseJsonObject(result.stdout);
			expect(envelope.ok).toBe(false);
			expect(envelope.verb).toBe("plan");
			expect(envelope.status).toBe("not_implemented");
			expect(envelope.code).toBe("HOBO_CLI_STUB");
			expect(String(envelope.message)).toMatch(/composed @hobo\/hobo binary/);
			expect(envelope.context).toMatchObject({ cwd, projectDir: cwd });
		});
	});

	it("does not report success for an unavailable command when HOBO_STUB_OK is set", async () => {
		await withBindle(async (cwd) => {
			vi.stubEnv("HOBO_STUB_OK", "1");
			try {
				const result = await runHobo(["plan", "--json"], { cwd });
				expect(result.exitCode).toBe(1);
				const envelope = parseJsonObject(result.stdout);
				expect(envelope.ok).toBe(false);
				expect(envelope.code).toBe("HOBO_CLI_STUB");
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});

	it("rejects unknown verbs and flags without guessing silently", async () => {
		await withBindle(async (cwd) => {
			const typo = await runHobo(["plann"], { cwd });
			expect(typo.exitCode).toBe(2);
			expect(typo.stdout).toBe("");
			expect(typo.stderr).toMatch(/Unknown verb "plann"/);
			expect(typo.stderr).toMatch(/Did you mean "plan"\?/);

			const flag = await runHobo(["plan", "--wat"], { cwd });
			expect(flag.exitCode).toBe(2);
			expect(flag.stdout).toBe("");
			expect(flag.stderr).toMatch(/Unknown option "--wat"/);
			expect(flag.stderr).toMatch(/Run "hobo plan --help"/);
		});
	});

	it("does not suggest verbs for short inputs more than one edit away", async () => {
		await withBindle(async (cwd) => {
			const result = await runHobo(["qeq"], { cwd });
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toMatch(/Unknown verb "qeq"/);
			expect(result.stderr).not.toMatch(/Did you mean/);
		});
	});

	it("prints stack diagnostics on internal errors only with --verbose", async () => {
		await withBindle(async (cwd) => {
			const cli = createHoboCli({
				commands: {
					plan: {
						run: async () => {
							throw new Error("boom-internal");
						},
					},
				},
			});

			const quiet_ = await cli.run(["plan"], { cwd });
			expect(quiet_.exitCode).toBe(1);
			expect(quiet_.stderr).toMatch(/Re-run with --verbose/);
			expect(quiet_.stderr).not.toMatch(/boom-internal/);

			const verbose = await cli.run(["plan", "--verbose"], { cwd });
			expect(verbose.exitCode).toBe(1);
			expect(verbose.stderr).toMatch(/boom-internal/);
			expect(verbose.stderr).not.toMatch(/Re-run with --verbose/);
		});
	});

	it("routes command progress to the onProgress sink unless -q/--json", async () => {
		await withBindle(async (cwd) => {
			const cli = createHoboCli({
				commands: {
					plan: {
						run: async ({ emitProgress }) => {
							emitProgress("plan: step one");
							return {
								ok: true,
								status: "ok",
								code: "HOBO_OK",
								message: "done",
								data: {},
							};
						},
					},
				},
			});

			const seen: string[] = [];
			await cli.run(["plan"], { cwd, onProgress: (m) => seen.push(m) });
			expect(seen).toEqual(["plan: step one"]);

			const quietSeen: string[] = [];
			await cli.run(["plan", "-q"], {
				cwd,
				onProgress: (m) => quietSeen.push(m),
			});
			expect(quietSeen).toEqual([]);

			const jsonSeen: string[] = [];
			await cli.run(["plan", "--json"], {
				cwd,
				onProgress: (m) => jsonSeen.push(m),
			});
			expect(jsonSeen).toEqual([]);
		});
	});

	it("emits JSON failure envelope with remediation for usage errors", async () => {
		await withBindle(async (cwd) => {
			const result = await runHobo(["plann", "--json"], { cwd });
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toBe("");

			const envelope = parseJsonObject(result.stdout);
			expect(envelope.ok).toBe(false);
			expect(envelope.code).toMatch(/^HOBO_/);
			expect(envelope.remediation).toEqual(
				expect.arrayContaining([expect.any(String)]),
			);
		});
	});

	it("keeps JSON stdout and human output separate", async () => {
		await withBindle(async (cwd) => {
			const json = await runHobo(["plan", "--json"], { cwd });
			expect(json.stderr).toBe("");
			expect(() => JSON.parse(json.stdout)).not.toThrow();
			expect(json.stdout).not.toMatch(/^Command\s+Status/m);

			const human = await runHobo(["plan"], { cwd });
			expect(human.exitCode).toBe(1);
			expect(human.stderr).toBe("");
			expect(human.stdout).toMatch(/^Command\s+Status/m);
			expect(() => JSON.parse(human.stdout)).toThrow();
		});
	});

	it("still prints failures to stderr in quiet mode", async () => {
		await withBindle(async (cwd) => {
			const quiet = await runHobo(["plan", "-q"], { cwd });
			expect(quiet.exitCode).toBe(1);
			expect(quiet.stdout).toBe("");
			expect(quiet.stderr).toMatch(/composed @hobo\/hobo binary/);
		});
	});

	it("fails outside a HoBo project with a clear no-Bindle error", async () => {
		await withEmptyDir(async (cwd) => {
			const result = await runHobo(["plan"], { cwd });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/No Bindle here/);
			expect(result.stderr).toMatch(/Run from a HoBo project or pass --cwd/);
		});
	});

	it("rejects conflicting lifecycle flags at parse time", async () => {
		await withBindle(async (cwd) => {
			const result = await runHobo(["up", "--to", "rev-123", "--rollback"], {
				cwd,
			});

			expect(result.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/--to cannot be combined with --rollback/);
		});
	});

	it("constructs command context once and injects it into dispatch", async () => {
		await withBindle(async (cwd) => {
			let contextBuilds = 0;
			let injectedContext: CliContext | undefined;
			const cli = createHoboCli({
				contextFactory: async (request) => {
					contextBuilds += 1;
					return {
						cwd: request.cwd,
						projectDir: request.cwd,
						identity: `user:ctx-${contextBuilds}`,
						clients: { readApi: "fake-read-api", runtime: "fake-runtime" },
					};
				},
				commands: {
					plan: {
						run: async ({ context }) => {
							injectedContext = context;
							return {
								ok: true,
								status: "ok",
								code: "HOBO_OK",
								data: {
									identity: context.identity,
								},
							};
						},
					},
				},
			});

			const result = await cli.run(["plan", "--json"], { cwd });
			const envelope = parseJsonObject(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(contextBuilds).toBe(1);
			expect(injectedContext?.identity).toBe("user:ctx-1");
			expect(envelope.data).toMatchObject({ identity: "user:ctx-1" });
		});
	});
});
