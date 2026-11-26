import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { CANONICAL_VERBS, createHoboCli, helpText, runHobo } from "../src/cli-shell.js";

const canonicalVerbNames = [
  "up",
  "down",
  "dev",
  "new",
  "login",
  "claim",
  "plan",
  "verify",
  "can-deploy",
  "inspect",
  "logs",
  "doctor",
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
  "derivative",
  "runbook"
];

const globalFlags = ["--json", "--camp <camp>", "--cwd <path>", "--verbose", "-q", "--help"];

const goldenHelp = `HoBo CLI

Usage:
  hobo [global flags] <verb> [args]
  hobo --help
  hobo <verb> --help

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
  claim       identity      Bind an anonymous deployment to an account
  plan        read-only     Dry-run the up decision
  verify      read-only     Run the unified Gatekeeper preflight
  can-deploy  read-only     Diagnose producer/consumer compatibility
  inspect     read-only     Render projections and time-travel views
  logs        read-only     Live-tail Camp runtime streams
  doctor      diagnostics   Report environment and portability hazards
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
  derivative  extensibility Manage derived HoBo implementations
  runbook     SRE           Execute or replay incident runbooks
`;

async function withBindle(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-shell-"));
  await writeFile(path.join(dir, "hobo.bindle.json"), JSON.stringify({ name: "snapshop" }));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withEmptyDir(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-empty-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("HoBo CLI shell contract", () => {
  it("pins hobo --help to the canonical HOBO-8 verbs and global flags", async () => {
    assert.deepEqual(CANONICAL_VERBS.map((verb) => verb.name), canonicalVerbNames);

    const result = await runHobo(["--help"], { cwd: process.cwd() });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, goldenHelp);
    assert.equal(result.stderr, "");
    assert.equal(helpText(), goldenHelp);

    const verbHelp = await runHobo(["plan", "--help"], { cwd: process.cwd() });
    assert.equal(verbHelp.exitCode, 0);
    assert.match(verbHelp.stdout, /Usage:\n  hobo plan \[global flags\] \[args\]/);
    assert.match(verbHelp.stdout, /Status: not yet implemented/);

    for (const flag of globalFlags) {
      assert.match(result.stdout, new RegExp(flag.replace(/[<>]/g, "\\$&")));
    }
    for (const retired of ["deploy", "destroy", "teardown", "rollback", "promote", "yard", "forge", "train", "crew", "fleet"]) {
      assert.doesNotMatch(result.stdout, new RegExp(`^  ${retired}\\s`, "m"));
    }
  });

  it("emits a well-formed JSON stub envelope for hobo plan --json", async () => {
    await withBindle(async (cwd) => {
      const result = await runHobo(["plan", "--json"], { cwd });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.doesNotMatch(result.stdout, /not yet implemented\nUsage:/);

      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.verb, "plan");
      assert.equal(envelope.status, "not_implemented");
      assert.equal(envelope.code, "HOBO_CLI_STUB");
      assert.equal(envelope.message, "plan is not yet implemented");
      assert.equal(envelope.context.cwd, cwd);
      assert.equal(envelope.context.projectDir, cwd);
      assert.equal(envelope.context.identity, null);
      assert.equal(envelope.context.clients.readApi, "stub");
      assert.equal(envelope.context.clients.runtime, "stub");
    });
  });

  it("stubs every canonical verb through the command registry", async () => {
    await withBindle(async (cwd) => {
      for (const verb of canonicalVerbNames) {
        const result = await runHobo([verb, "--json"], { cwd });
        const envelope = JSON.parse(result.stdout);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stderr, "");
        assert.equal(envelope.verb, verb);
        assert.equal(envelope.status, "not_implemented");
        assert.equal(envelope.code, "HOBO_CLI_STUB");
        assert.equal(envelope.message, `${verb} is not yet implemented`);
      }
    });
  });

  it("constructs command context once and injects it into dispatch", async () => {
    await withBindle(async (cwd) => {
      let contextBuilds = 0;
      let injectedContext;
      const cli = createHoboCli({
        contextFactory: async (request) => {
          contextBuilds += 1;
          return {
            cwd: request.cwd,
            projectDir: request.cwd,
            identity: { subject: "user:dev" },
            clients: { readApi: "fake-read-api", runtime: "fake-runtime" },
            buildId: `ctx-${contextBuilds}`
          };
        },
        commands: {
          plan: {
            run: async ({ context }) => {
              injectedContext = context;
              return {
                ok: true,
                status: "not_implemented",
                code: "HOBO_CLI_STUB",
                message: "plan is not yet implemented",
                data: { contextBuildId: context.buildId }
              };
            }
          }
        }
      });

      const result = await cli.run(["plan", "--json"], { cwd });
      const envelope = JSON.parse(result.stdout);

      assert.equal(result.exitCode, 0);
      assert.equal(contextBuilds, 1);
      assert.equal(injectedContext.buildId, "ctx-1");
      assert.equal(envelope.data.contextBuildId, "ctx-1");
    });
  });

  it("rejects unknown verbs and flags without guessing silently", async () => {
    await withBindle(async (cwd) => {
      const typo = await runHobo(["plna"], { cwd });
      assert.equal(typo.exitCode, 2);
      assert.equal(typo.stdout, "");
      assert.match(typo.stderr, /Unknown verb "plna"/);
      assert.match(typo.stderr, /Did you mean "plan"\?/);

      const flag = await runHobo(["plan", "--wat"], { cwd });
      assert.equal(flag.exitCode, 2);
      assert.equal(flag.stdout, "");
      assert.match(flag.stderr, /Unknown option "--wat"/);
      assert.match(flag.stderr, /Run "hobo plan --help"/);
    });
  });

  it("keeps JSON stdout and human output separate", async () => {
    await withBindle(async (cwd) => {
      const json = await runHobo(["plan", "--json"], { cwd });
      assert.equal(json.stderr, "");
      assert.doesNotThrow(() => JSON.parse(json.stdout));
      assert.doesNotMatch(json.stdout, /^Command\s+Status/m);

      const human = await runHobo(["plan"], { cwd });
      assert.equal(human.exitCode, 0);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /^Command\s+Status/m);
      assert.throws(() => JSON.parse(human.stdout), SyntaxError);
    });
  });

  it("fails outside a HoBo project with a clear no-Bindle error", async () => {
    await withEmptyDir(async (cwd) => {
      const result = await runHobo(["plan"], { cwd });

      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /No Bindle here/);
      assert.match(result.stderr, /Run from a HoBo project or pass --cwd/);
      assert.doesNotMatch(result.stderr, /Error:|at\s+\S+\s+\(/);
    });
  });

  it("rejects conflicting lifecycle flags at parse time", async () => {
    await withBindle(async (cwd) => {
      const result = await runHobo(["up", "--to", "rev-123", "--rollback"], { cwd });

      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--to cannot be combined with --rollback/);
      assert.doesNotMatch(result.stderr, /Error:|at\s+\S+\s+\(/);
    });
  });
});
