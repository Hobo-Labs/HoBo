import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { createHoboCli } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import {
  createDoctorCommand,
  createHoboDoctorCli,
  createHealthyDoctorFixture,
} from "../src/doctor-contract.js";

test("missing toolchain and missing SVID produce fix commands without secrets", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboDoctorCli({
      ...createHealthyDoctorFixture(),
      toolchain: {
        node: { ok: false, fix: "Install Node.js 22 LTS" },
        jco: { ok: false, fix: "npm install -g @bytecodealliance/jco" },
        containerRuntime: { ok: false, fix: "Install Docker or Podman" },
      },
      credentialStore: {
        async read() {
          return null;
        },
      },
    });

    const result = await cli.run(["--json"], { cwd });
    const report = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.status, "failed");
    assert.match(report.summary, /missing required doctor checks/);
    assert.equal(check(report, "toolchain.node").status, "fail");
    assert.equal(check(report, "toolchain.node").remediation.command, "Install Node.js 22 LTS");
    assert.equal(check(report, "toolchain.jco").remediation.command, "npm install -g @bytecodealliance/jco");
    assert.equal(check(report, "toolchain.containerRuntime").remediation.command, "Install Docker or Podman");
    assert.equal(check(report, "identity.svid").status, "fail");
    assert.match(check(report, "identity.svid").message, /not logged in -> hobo login/);
    assert.doesNotMatch(result.stdout, /eyJ|token|secret/i);
  });
});

test("raw access is reported with file and line in a stable JSON envelope", async () => {
  await withProject(async (cwd) => {
    await writeFile(
      path.join(cwd, "app.ts"),
      [
        "export async function handler(ctx) {",
        "  return ctx.bindings.db.raw((driver) => driver.query('select * from users'));",
        "}",
        "",
      ].join("\n"),
    );
    const cli = createHoboDoctorCli(createHealthyDoctorFixture());

    const first = await cli.run(["--json"], { cwd });
    const second = await cli.run(["--json"], { cwd });
    const report = JSON.parse(first.stdout);

    assert.equal(first.exitCode, 0);
    assert.deepEqual(JSON.parse(second.stdout), report);
    assert.equal(report.status, "warning");
    assert.deepEqual(report.findings.map((finding) => finding.code), ["portability.raw-access"]);
    assert.equal(report.findings[0].file, "app.ts");
    assert.equal(report.findings[0].line, 2);
    assert.match(report.findings[0].message, /non-portable/);
  });
});

test("healthy project reports all green in human and JSON output", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboDoctorCli(createHealthyDoctorFixture());

    const human = await cli.run([], { cwd });
    const json = await cli.run(["--json"], { cwd });
    const report = JSON.parse(json.stdout);

    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /All doctor checks passed/);
    assert.equal(human.stderr, "");
    assert.equal(json.exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.status, "healthy");
    assert.equal(report.findings.length, 0);
    assert.ok(report.checks.every((entry) => entry.status === "pass"));
  });
});

test("degraded environments warn, while offline mode skips remote connectivity", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboDoctorCli({
      ...createHealthyDoctorFixture(),
      connectivity: {
        readApi: async () => ({ ok: true }),
        streamer: async () => ({
          ok: false,
          severity: "warning",
          message: "Streamer reachable but lagging behind head",
          remediation: "Check Camp Streamer health",
        }),
      },
    });

    const degraded = JSON.parse((await cli.run(["--json"], { cwd })).stdout);
    assert.equal(degraded.status, "warning");
    assert.equal(check(degraded, "connectivity.streamer").status, "warn");

    const offline = JSON.parse((await cli.run(["--json", "--offline"], { cwd })).stdout);
    assert.equal(offline.ok, true);
    assert.equal(check(offline, "connectivity.readApi").status, "skip");
    assert.equal(check(offline, "connectivity.streamer").status, "skip");
  });
});

test("check failures are reported as check errored and do not crash doctor", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboDoctorCli({
      ...createHealthyDoctorFixture(),
      extraChecks: [
        {
          id: "custom.explodes",
          title: "Custom integration",
          async run() {
            throw new Error("custom check exploded with token=super-secret");
          },
        },
      ],
    });

    const result = await cli.run(["--json"], { cwd });
    const report = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(check(report, "custom.explodes").status, "fail");
    assert.match(check(report, "custom.explodes").message, /check errored/);
    assert.doesNotMatch(result.stdout, /super-secret/);
    assert.doesNotMatch(result.stderr, /Error:|at\s+\S+\s+\(/);
  });
});

test("toolchain probe errors stay inside the doctor JSON envelope", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboDoctorCli({
      ...createHealthyDoctorFixture(),
      toolchain: {
        node: async () => {
          throw new Error("node probe failed with token=super-secret");
        },
        jco: { ok: true },
        containerRuntime: { ok: true },
      },
    });

    const result = await cli.run(["--json"], { cwd });
    const report = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.equal(check(report, "toolchain.node").status, "fail");
    assert.match(check(report, "toolchain.node").message, /check errored/);
    assert.doesNotMatch(result.stdout, /super-secret|Error:|at\s+\S+\s+\(/);
  });
});

test("diagnostics redact credential tokens and bearer secrets", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboDoctorCli({
      ...createHealthyDoctorFixture({
        credential: {
          svidRef: "keychain://hobo.dev-svid",
          token: "eyJhbGciOiJIUzI1NiJ9.secret.payload",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      }),
      connectivity: {
        readApi: async () => {
          throw new Error("read API rejected Authorization: Bearer live-secret-token");
        },
        streamer: async () => ({ ok: true }),
      },
    });

    const result = await cli.run(["--json"], { cwd });

    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stdout, /eyJhbGciOiJIUzI1NiJ9/);
    assert.doesNotMatch(result.stdout, /live-secret-token/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });
});

test("doctor hard failures exit nonzero through the command registry", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboCli({
      contextFactory: async () => ({
        cwd,
        projectDir: cwd,
        identity: null,
        clients: { readApi: "stub", runtime: "stub" },
      }),
      commands: {
        doctor: createDoctorCommand({
          ...createHealthyDoctorFixture(),
          credentialStore: {
            async read() {
              return null;
            },
          },
        }),
      },
    });

    const result = await cli.run(["doctor", "--json"], { cwd });
    const envelope = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.status, "failed");
    assert.equal(check(envelope.data, "identity.svid").status, "fail");
  });
});

test("doctor can run as the HOBO-115 command-registry implementation", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboCli({
      contextFactory: async () => ({
        cwd,
        projectDir: cwd,
        identity: { subject: "spiffe://yard/acme/agent/dev-cli" },
        clients: { readApi: "stub", runtime: "stub" },
      }),
      commands: {
        doctor: createDoctorCommand(createHealthyDoctorFixture()),
      },
    });

    const result = await cli.run(["doctor", "--json"], { cwd });
    const envelope = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(envelope.verb, "doctor");
    assert.equal(envelope.status, "healthy");
    assert.equal(envelope.data.schema, "hobo.doctor/v1");
    assert.equal(envelope.data.ok, true);
  });
});

test("doctor offline flag reaches the command-registry implementation", async () => {
  await withProject(async (cwd) => {
    const cli = createHoboCli({
      contextFactory: async () => ({
        cwd,
        projectDir: cwd,
        identity: { subject: "spiffe://yard/acme/agent/dev-cli" },
        clients: { readApi: "stub", runtime: "stub" },
      }),
      commands: {
        doctor: createDoctorCommand(createHealthyDoctorFixture()),
      },
    });

    const result = await cli.run(["doctor", "--json", "--offline"], { cwd });
    const envelope = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(check(envelope.data, "connectivity.readApi").status, "skip");
    assert.equal(check(envelope.data, "connectivity.streamer").status, "skip");
  });
});

async function withProject(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "hobo-doctor-"));
  await writeFile(path.join(dir, "hobo.bindle.json"), JSON.stringify({ name: "snapshop" }));
  await mkdir(path.join(dir, ".hobo"));
  await writeFile(path.join(dir, ".hobo", "manifest.json"), JSON.stringify({ version: 1 }));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function check(report, id) {
  const entry = report.checks.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing check ${id}`);
  return entry;
}
