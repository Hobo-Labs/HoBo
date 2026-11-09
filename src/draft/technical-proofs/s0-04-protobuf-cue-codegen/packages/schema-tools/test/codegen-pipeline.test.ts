import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCodegen, runCodegen } from "../src/codegen.js";
import { parseCodegenArgv } from "../src/parse.js";
import { runCli } from "../src/cli.js";
import { createCodegenReport, reportToJson } from "../src/types.js";
import { vetReportEnvelope } from "../src/cue.js";

import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL("../../../../../../..", import.meta.url)));
const POC_ROOT = join(
  REPO_ROOT,
  "src/draft/technical-proofs/s0-04-protobuf-cue-codegen",
);
const POC_PACKAGES = join(
  REPO_ROOT,
  "src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages",
);
const CODEGEN_INTEGRATION_TIMEOUT_MS = 60_000;

function invocation(check = false) {
  return Object.freeze({
    ...parseCodegenArgv(check ? ["--check"] : [], REPO_ROOT),
    packagesRoot: POC_PACKAGES,
  });
}

describe("codegen determinism", () => {
  it("writes byte-identical output on consecutive runs", async () => {
    const opts = invocation(false);
    const first = await runCodegen(opts);
    const second = await runCodegen(opts);
    expect(first.status).toBe("CLEAN");
    expect(second.status).toBe("CLEAN");
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("drift gate", () => {
  it("checkCodegen reports DRIFT for tampered generated file without mutating disk", async () => {
    const generated = join(
      POC_PACKAGES,
      "core/src/_generated/hobo/core/v1/event_envelope_pb.ts",
    );
    const before = await readFile(generated, "utf8");
    const { writeFile, stat } = await import("node:fs/promises");
    try {
      await writeFile(generated, `${before}// tampered\n`);
      const beforeStat = await stat(generated);

      const report = await checkCodegen(invocation(true));
      const after = await readFile(generated, "utf8");
      const afterStat = await stat(generated);

      expect(report.status).toBe("DRIFT");
      expect(report.drift.some((entry) => entry.path.includes("event_envelope_pb.ts"))).toBe(true);
      expect(after).toBe(`${before}// tampered\n`);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    } finally {
      await writeFile(generated, before);
    }
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("CUE lane", () => {
  it("accepts valid fixtures and rejects invalid fixtures fail-closed", async () => {
    const report = await checkCodegen(invocation(true));
    expect(report.cueViolations).toHaveLength(0);
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("json envelope", () => {
  it("round-trips CLEAN report and satisfies CUE constraints", async () => {
    // Scoped to this POC tree: the promoted @hobo/schema-tools suite owns the
    // whole-repo check. This frozen generator predates production's
    // import_extension=js, so a whole-repo run here reports production's
    // current output as drift (promotions.json: reference).
    const result = await runCli(["--check", "--json"], POC_ROOT);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("CLEAN");
    expect(Array.isArray(envelope.drift)).toBe(true);

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "codegen-report-"));
    const path = join(dir, "report.json");
    await writeFile(path, result.stdout);
    const cue = await vetReportEnvelope(REPO_ROOT, path);
    await rm(dir, { recursive: true, force: true });
    expect(cue.ok).toBe(true);

    const sample = createCodegenReport({ status: "CLEAN", durationMs: 1 });
    expect(JSON.parse(reportToJson(sample)).status).toBe("CLEAN");
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("pact consumer", () => {
  it("pins CI envelope fields status and drift[].path", async () => {
    const pactPath = join(
      import.meta.dirname,
      "../contracts/pacts/schema_tools_codegen_report.pact.json",
    );
    const pact = JSON.parse(await readFile(pactPath, "utf8"));
    expect(pact.consumer.name).toBe("HoboCiSchemaGate");
    expect(pact.provider.name).toBe("SchemaToolsCodegen");
    const clean = pact.interactions.find((item: { description: string }) =>
      item.description.includes("CLEAN"),
    );
    expect(clean.response.body.status).toBe("CLEAN");
    const drift = pact.interactions.find((item: { description: string }) =>
      item.description.includes("drift"),
    );
    expect(drift.response.body.drift[0].path).toContain("_generated");
  });
});
