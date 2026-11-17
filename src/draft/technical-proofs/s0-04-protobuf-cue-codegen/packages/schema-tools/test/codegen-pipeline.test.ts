import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCodegen, runCodegen } from "../src/codegen.js";
import { parseCodegenArgv } from "../src/parse.js";
import { runCli } from "../src/cli.js";
import { type CodegenReport, createCodegenReport, reportToJson } from "../src/types.js";
import { vetReportEnvelope, withTempDirectory } from "../src/cue.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../../../../../..", import.meta.url)));
const POC_ROOT = join(REPO_ROOT, "src/draft/technical-proofs/s0-04-protobuf-cue-codegen");
const POC_PACKAGES = join(POC_ROOT, "packages");
const CODEGEN_INTEGRATION_TIMEOUT_MS = 60_000;
const GENERATED = "core/src/_generated/hobo/core/v1/event_envelope_pb.ts";

async function withProofCopy<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hobo-codegen-proof-"));
  try {
    await cp(POC_PACKAGES, join(root, "packages"), { recursive: true });
    await cp(join(POC_ROOT, "buf.gen.yaml"), join(root, "buf.gen.yaml"));
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function invocation(root: string, check = false) {
  return Object.freeze({
    ...parseCodegenArgv(check ? ["--check"] : [], REPO_ROOT),
    packagesRoot: join(root, "packages"),
    bufTemplate: join(root, "buf.gen.yaml"),
  });
}

describe("temporary directories", () => {
  it("uses the system temporary directory and removes it after failure", async () => {
    let directory = "";
    await expect(withTempDirectory("hobo-proof-test-", async (path) => {
      directory = path;
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(existsSync(path)).toBe(true);
      throw new Error("fixture failure");
    })).rejects.toThrow("fixture failure");
    expect(existsSync(directory)).toBe(false);
  });
});

describe("codegen determinism", () => {
  it("writes identical output on consecutive runs without replacing unrelated files", async () => {
    await withProofCopy(async (root) => {
      const generated = join(root, "packages", GENERATED);
      const unrelated = join(root, "packages/core/src/_generated/unrelated.ts");
      await writeFile(unrelated, "export const keep = true;\n");
      const first = await runCodegen(invocation(root));
      const firstOutput = await readFile(generated, "utf8");
      const second = await runCodegen(invocation(root));
      expect(first.status).toBe("CLEAN");
      expect(second.status).toBe("CLEAN");
      expect(await readFile(generated, "utf8")).toBe(firstOutput);
      expect(firstOutput).toContain("// @generated");
      expect(firstOutput).not.toContain("DO NOT EDIT");
      expect(await readFile(unrelated, "utf8")).toBe("export const keep = true;\n");
    });
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("drift gate", () => {
  it("reports a tampered generated file without mutating it", async () => {
    await withProofCopy(async (root) => {
      const generated = join(root, "packages", GENERATED);
      const tampered = `${await readFile(generated, "utf8")}// tampered\n`;
      await writeFile(generated, tampered);
      const before = await stat(generated);
      const report = await checkCodegen(invocation(root, true));
      const after = await stat(generated);
      expect(report.status).toBe("DRIFT");
      expect(report.drift.some((entry) => entry.path.includes("event_envelope_pb.ts"))).toBe(true);
      expect(await readFile(generated, "utf8")).toBe(tampered);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("CUE lane", () => {
  it("accepts valid fixtures and rejects invalid fixtures fail-closed", async () => {
    await withProofCopy(async (root) => {
      const report = await checkCodegen(invocation(root, true));
      expect(report.status).toBe("CLEAN");
      expect(report.cueViolations).toHaveLength(0);
    });
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

describe("json envelope", () => {
  it("round-trips CLEAN report and satisfies CUE constraints", async () => {
    await withProofCopy(async (root) => {
      const result = await runCli(["--check", "--json"], root);
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.status).toBe("CLEAN");
      expect(Array.isArray(envelope.drift)).toBe(true);
      const path = join(root, "report.json");
      await writeFile(path, result.stdout);
      expect((await vetReportEnvelope(REPO_ROOT, path)).ok).toBe(true);
      const sample = createCodegenReport({ status: "CLEAN", durationMs: 1 });
      expect(JSON.parse(reportToJson(sample)).status).toBe("CLEAN");
    });
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});

const withContractWorkspace = withProofCopy;

type CodegenContract = {
  consumer: { name: string };
  provider: { name: string };
  metadata: { pactSpecification: { version: string }; transport: string };
  interactions: Array<{
    type: string;
    description: string;
    providerStates: Array<{ name: string }>;
    request: { contents: { contentType: string; encoded: false; content: { argv: string[] } } };
    response: Array<{ contents: { contentType: string; encoded: false; content: { exitCode: number; report: Pick<CodegenReport, "status" | "drift" | "cueViolations"> } } }>;
  }>;
};

describe("codegen CLI contract", () => {
  it("executes every recorded invocation against current and modified generated output", async () => {
    const pact: CodegenContract = JSON.parse(await readFile(
      join(import.meta.dirname, "../contracts/pacts/schema_tools_codegen_report.pact.json"),
      "utf8",
    ));
    expect(pact.consumer.name).toBe("HoboCiSchemaGate");
    expect(pact.provider.name).toBe("SchemaToolsCodegen");
    expect(pact.metadata).toEqual({ pactSpecification: { version: "4.0.0" }, transport: "cli-json" });
    expect(pact.interactions).toHaveLength(2);
    for (const interaction of pact.interactions) {
      expect(interaction.type).toBe("Synchronous/Messages");
      expect(interaction.request.contents.contentType).toBe("application/json");
      expect(interaction.request.contents.encoded).toBe(false);
      expect(interaction.response).toHaveLength(1);
      const response = interaction.response[0];
      if (!response) throw new Error("missing contract response");
      expect(response.contents.contentType).toBe("application/json");
      expect(response.contents.encoded).toBe(false);
      await withContractWorkspace(async (root) => {
        const generated = join(root, "packages/core/src/_generated/hobo/core/v1/event_envelope_pb.ts");
        const state = interaction.providerStates[0]?.name;
        if (state === "the event envelope output is modified") {
          await writeFile(generated, `${await readFile(generated, "utf8")}\nexport const modified = true;\n`);
        } else if (state !== "generated output is current") {
          throw new Error(`unknown provider state: ${state}`);
        }
        const before = await readFile(generated, "utf8");
        const result = await runCli(interaction.request.contents.content.argv, root);
        expect(result.stderr).toBe("");
        expect({ exitCode: result.exitCode, report: JSON.parse(result.stdout) }).toMatchObject(response.contents.content);
        expect(await readFile(generated, "utf8")).toBe(before);
      });
    }
  }, CODEGEN_INTEGRATION_TIMEOUT_MS);
});
