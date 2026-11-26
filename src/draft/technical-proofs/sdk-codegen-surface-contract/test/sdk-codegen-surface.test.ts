import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  CodegenSurfaceError,
  compareGeneratedTree,
  createMcpCodegenTool,
  createSdkCodegenCommand,
  fixtureSdkSources,
  generateSdkCodegenArtifacts,
  withTempSdkProject,
  writeGeneratedTree,
} from "../src/sdk-codegen-surface.js";

const expectedPaths = [
  ".hobo/generated/codegen-manifest.json",
  ".hobo/generated/domain.pb.json",
  ".hobo/generated/mcp-codegen-tool.json",
  "src/_generated/api-tree.d.ts",
  "src/_generated/bindings.d.ts",
  "src/_generated/domain.d.ts",
  "src/_generated/domain.zod.ts",
  "src/_generated/hooks.d.ts",
  "src/_generated/steps.d.ts",
  "src/_generated/with-options.d.ts",
  "src/_generated/workflows.d.ts",
];

function artifactPaths(artifacts) {
  return artifacts.map((artifact) => artifact.path);
}

function artifactText(artifacts, path) {
  const artifact = artifacts.find((entry) => entry.path === path);
  assert.ok(artifact, `missing generated artifact ${path}`);
  return artifact.content;
}

test("generates the checked-in SDK surface from WIT, Zod, allow scopes, and the bindle graph", () => {
  const artifacts = generateSdkCodegenArtifacts({
    sources: fixtureSdkSources(),
  });

  assert.deepEqual(artifactPaths(artifacts), expectedPaths);

  const bindings = artifactText(artifacts, "src/_generated/bindings.d.ts");
  assert.match(bindings, /readonly db: DataClient<"db", "read" \| "write" \| "query">;/);
  assert.match(bindings, /readonly uploads: BlobClient<"uploads", "read">;/);
  assert.match(bindings, /readonly legacyRows: RawQuery<"db", unknown>;/);
  assert.doesNotMatch(bindings, /\bany\b/);

  const apiTree = artifactText(artifacts, "src/_generated/api-tree.d.ts");
  assert.match(apiTree, /readonly "api.tickets.list": QueryRef<"listTickets", Ticket>;/);
  assert.match(apiTree, /readonly "api.tickets.create": MutationRef<"createTicket", TicketDraft, Ticket>;/);

  assert.match(
    artifactText(artifacts, "src/_generated/steps.d.ts"),
    /export declare function sendTicketEmail\(input: TicketEmailInput\): Promise<TicketEmailResult>;/,
  );
  assert.match(
    artifactText(artifacts, "src/_generated/workflows.d.ts"),
    /export declare function closeTicket\(input: CloseTicketInput\): Promise<CloseTicketResult>;/,
  );
  assert.match(
    artifactText(artifacts, "src/_generated/with-options.d.ts"),
    /readonly "aws.rds": AwsRdsOptions;/,
  );

  const protobuf = JSON.parse(artifactText(artifacts, ".hobo/generated/domain.pb.json"));
  assert.deepEqual(protobuf.messages.Ticket.fields.id, { id: 1, type: "string" });
  assert.deepEqual(protobuf.messages.TicketDraft.fields.title, { id: 1, type: "string" });
  assert.match(
    artifactText(artifacts, "src/_generated/domain.zod.ts"),
    /export const TicketSchema = z\.object/,
  );

  const manifest = JSON.parse(artifactText(artifacts, ".hobo/generated/codegen-manifest.json"));
  assert.equal(manifest.schema, "hobo.codegen/v1");
  assert.equal(manifest.sources.wit.interfaces.length, 3);
  assert.deepEqual(manifest.rawEscapes, [
    {
      name: "legacyRows",
      resource: "db",
      type: "unknown",
      portability: "flagged",
    },
  ]);
});

test("editing an allow scope changes generated bindings deterministically", () => {
  const full = generateSdkCodegenArtifacts({ sources: fixtureSdkSources() });
  const narrowed = generateSdkCodegenArtifacts({
    sources: fixtureSdkSources({
      allowScopes: {
        db: ["read"],
        uploads: ["read"],
      },
    }),
  });
  const repeated = generateSdkCodegenArtifacts({
    sources: fixtureSdkSources({
      allowScopes: {
        uploads: ["read"],
        db: ["read"],
      },
    }),
  });

  assert.notEqual(
    artifactText(full, "src/_generated/bindings.d.ts"),
    artifactText(narrowed, "src/_generated/bindings.d.ts"),
  );
  assert.match(
    artifactText(narrowed, "src/_generated/bindings.d.ts"),
    /readonly db: DataClient<"db", "read">;/,
  );
  assert.doesNotMatch(
    artifactText(narrowed, "src/_generated/bindings.d.ts"),
    /"write" \| "query"/,
  );
  assert.deepEqual(narrowed, repeated);
});

test("codegen --check and MCP parity pass on fresh output and fail on stale output without mutation", async () => {
  await withTempSdkProject(async (projectRoot) => {
    const cli = createSdkCodegenCommand({ sources: fixtureSdkSources() });
    const mcp = createMcpCodegenTool({ sources: fixtureSdkSources() });

    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);
    assert.equal((await cli.run(["codegen", "--check"], { cwd: projectRoot })).exitCode, 0);
    assert.deepEqual(await mcp.invoke({ cwd: projectRoot, check: true }), {
      ok: true,
      drift: [],
      generatedPaths: expectedPaths,
    });

    const stalePath = join(projectRoot, "src/_generated/api-tree.d.ts");
    await writeFile(stalePath, "// stale api tree\n");
    const before = await readFile(stalePath, "utf8");

    const check = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });
    const after = await readFile(stalePath, "utf8");

    assert.equal(check.exitCode, 1);
    assert.deepEqual(JSON.parse(check.stdout).drift, [
      {
        status: "changed",
        path: "src/_generated/api-tree.d.ts",
      },
    ]);
    assert.equal(after, before);
    assert.deepEqual(await mcp.invoke({ cwd: projectRoot, check: true }), {
      ok: false,
      drift: [
        {
          status: "changed",
          path: "src/_generated/api-tree.d.ts",
        },
      ],
      generatedPaths: expectedPaths,
    });
  });
});

test("same sources generate byte-identical output independent of input ordering", () => {
  const forward = generateSdkCodegenArtifacts({ sources: fixtureSdkSources() });
  const reverse = generateSdkCodegenArtifacts({ sources: fixtureSdkSources({ reverse: true }) });

  assert.deepEqual(reverse, forward);
});

test("coverage gaps fail closed instead of emitting any-typed clients", () => {
  assert.throws(
    () =>
      generateSdkCodegenArtifacts({
        sources: fixtureSdkSources({
          coverage: {
            ok: false,
            unobservedResources: ["cache"],
          },
        }),
      }),
    (error) => {
      assert.ok(error instanceof CodegenSurfaceError);
      assert.equal(error.code, "HOBO_CODEGEN_COVERAGE_GAP");
      assert.match(error.message, /cache/);
      return true;
    },
  );
});

test("generated tree comparison records added, changed, and deleted paths deterministically", async () => {
  await withTempSdkProject(async (projectRoot) => {
    const artifacts = generateSdkCodegenArtifacts({ sources: fixtureSdkSources() });
    await writeGeneratedTree(projectRoot, artifacts);
    await writeFile(join(projectRoot, "src/_generated/hooks.d.ts"), "// stale\n");
    await writeFile(join(projectRoot, "src/_generated/extra.d.ts"), "// extra\n");

    const drift = await compareGeneratedTree(projectRoot, artifacts);

    assert.deepEqual(drift, [
      {
        status: "deleted",
        path: "src/_generated/extra.d.ts",
      },
      {
        status: "changed",
        path: "src/_generated/hooks.d.ts",
      },
    ]);
  });
});
