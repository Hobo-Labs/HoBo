import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  withTempSdkProject,
  writeGeneratedTree,
} from "../../sdk-codegen-surface-contract/src/sdk-codegen-surface.ts";
import {
  SDK_MANIFEST_IR_ARTIFACT_RELATIVE_PATH,
  runIfcAuthorFlow,
  runIfcAuthorFlowWithCoverageGap,
  runIfcAuthorFlowWithNarrowingFailure,
  stableManifestJson,
  writeSdkManifestIrArtifact,
} from "../src/ifc-author-flow.mjs";

const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url),
);

test("sample Bindle drives declare to collect to infer to codegen to manifest", async () => {
  const result = await runIfcAuthorFlow();

  assert.equal(result.collection.coverage.status, "pass");
  assert.deepEqual(Object.keys(result.manifest.resources).sort(), [
    "api",
    "config",
    "jobs",
    "todos",
    "uploads",
  ]);
  assert.deepEqual(result.manifest.resources.todos.allow, ["get", "set"]);
  assert.deepEqual(result.manifest.resources.uploads.allow, ["read", "write"]);
  assert.deepEqual(result.manifest.resources.jobs.allow, ["enqueue"]);
  assert.deepEqual(result.manifest.resources.config.allow, ["access"]);
  assert.deepEqual(result.manifest.connectors.asana.allow, ["tasks:write"]);
  assert.equal(result.manifest.connectors.asana.onBehalfOf, "user");
  assert.equal(result.validation.valid, true);
  assert.equal(result.generated.typeCheck.ok, true);
  assert.deepEqual(result.generated.typeCheck.missing, []);
  assert.equal(result.generated.codegenManifest.schema, "hobo.codegen/v1");
  assert.deepEqual(result.generated.codegenManifest.sources.allowScopes.todos, ["get", "set"]);
  assert.equal(result.generated.paths.includes("src/_generated/bindings.d.ts"), true);
});

test("generated TypeScript surface compiles for the sample Bindle consumer", async () => {
  const result = await runIfcAuthorFlow();

  await withTempSdkProject(async (projectRoot) => {
    await writeGeneratedTree(projectRoot, result.generated.artifacts);
    await mkdir(join(projectRoot, "test-types"), { recursive: true });
    await writeFile(join(projectRoot, "test-types", "consumer.ts"), typeConsumerSource());
    await writeFile(
      join(projectRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["test-types/**/*.ts", "src/_generated/**/*.d.ts"],
        },
        null,
        2,
      ),
    );

    const compile = spawnSync(
      process.execPath,
      [tscPath, "--noEmit", "--project", "tsconfig.json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    );

    assert.equal(
      compile.status,
      0,
      [compile.error?.message, compile.stdout, compile.stderr].filter(Boolean).join("\n") ||
        "TypeScript exited non-zero",
    );
  });
});

test("SDK test run writes an uploadable manifest IR artifact like a Pact JSON", async () => {
  const result = await runIfcAuthorFlow();
  const artifact = await writeSdkManifestIrArtifact({ result });
  const written = await readFile(artifact.path, "utf8");

  assert.equal(artifact.relativePath, SDK_MANIFEST_IR_ARTIFACT_RELATIVE_PATH);
  assert.equal(artifact.contentType, "application/vnd.hobo.manifest+json");
  assert.equal(artifact.upload.target, "ManifestIrRegistry");
  assert.equal(artifact.upload.path, "/manifests");
  assert.equal(artifact.manifestHash, result.manifestHash);
  assert.equal(written, stableManifestJson(result.manifest));
  assert.deepEqual(JSON.parse(written), result.manifest);
});

test("collection coverage fails the integrated path for unobserved branch resources", async () => {
  const failure = await runIfcAuthorFlowWithCoverageGap();

  assert.equal(failure.ok, false);
  assert.equal(failure.phase, "collection-coverage");
  assert.equal(failure.diagnostics[0].code, "collection.coverage.unobserved-resource");
  assert.equal(failure.diagnostics[0].resourceId, "auditLog");
});

test(".allow narrowing below usage fails can-deploy before codegen", async () => {
  const failure = await runIfcAuthorFlowWithNarrowingFailure();

  assert.equal(failure.ok, false);
  assert.equal(failure.phase, "permission-contract");
  assert.equal(failure.failures[0].code, "capability.required-not-granted");
  assert.deepEqual(failure.failures[0].missing, ["set"]);
});

test("author flow artifacts are deterministic byte-for-byte", async () => {
  const first = await runIfcAuthorFlow();
  const second = await runIfcAuthorFlow();

  assert.equal(second.manifestHash, first.manifestHash);
  assert.deepEqual(second.generated.artifacts, first.generated.artifacts);
});

function typeConsumerSource() {
  return `import type { ApiTree } from "../src/_generated/api-tree";
import type { BlobClient, CtxBindings, DataClient } from "../src/_generated/bindings";
import type { Todo, TodoDraft } from "../src/_generated/domain";

type BindingVerbs<T> = T extends DataClient<string, infer Verbs>
  ? Verbs
  : T extends BlobClient<string, infer Verbs>
    ? Verbs
    : never;

declare const bindings: CtxBindings;
declare const api: ApiTree;

const todoRead: BindingVerbs<typeof bindings.todos> = "get";
const todoWrite: BindingVerbs<typeof bindings.todos> = "set";
const uploadRead: BindingVerbs<typeof bindings.uploads> = "read";
const uploadWrite: BindingVerbs<typeof bindings.uploads> = "write";
const jobVerb: BindingVerbs<typeof bindings.jobs> = "enqueue";
const configVerb: BindingVerbs<typeof bindings.config> = "access";

const todoFromCreate: Todo = api["api.todos.create"].returns;
const draftForCreate: TodoDraft = api["api.todos.create"].input;
const todoFromList: Todo = api["api.todos.list"].returns;

void todoRead;
void todoWrite;
void uploadRead;
void uploadWrite;
void jobVerb;
void configVerb;
void todoFromCreate;
void draftForCreate;
void todoFromList;
`;
}
