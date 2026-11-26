import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCollectionCoverage } from "../../collection-coverage-gate-contract/src/collection-coverage-gate.ts";
import { canonicalManifestHash, validateManifest } from "../../hobo-manifest-contract/src/manifest.ts";
import { collectBindleResources } from "../../resource-collection-engine-contract/src/resource-collection-engine.ts";
import { buildUsagePermissionManifest } from "../../usage-inferred-permissions-contract/src/usage-permissions.ts";
import { inferConnectorScopes } from "../../../exp-proofs/api/xaa-scope-inference-contract/src/xaa-scope-inference.mjs";
import { generateSdkCodegenArtifacts } from "../../sdk-codegen-surface-contract/src/sdk-codegen-surface.ts";

const SAMPLE_BINDLE_ID = "support-desk";
const SAMPLE_FILE_NAME = "examples/support-desk.bindle.ts";
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const SDK_MANIFEST_IR_ARTIFACT_RELATIVE_PATH =
  "contracts/manifests/support-desk.manifest.json";
export const SDK_MANIFEST_IR_CONTENT_TYPE = "application/vnd.hobo.manifest+json";

const ASANA_BINDING = Object.freeze({
  asana: Object.freeze({
    via: "oauth",
    flow: Object.freeze({ audience: "https://app.asana.com" }),
    advertisedScopes: Object.freeze(["tasks:read", "tasks:write"]),
    operationScopes: Object.freeze({
      "tasks.create": "tasks:write",
      "tasks.list": "tasks:read",
    }),
  }),
});

export async function runIfcAuthorFlow() {
  return runFlow({
    sourceText: sampleBindleSource(),
    define: defineSampleBindle,
  });
}

export async function runIfcAuthorFlowWithCoverageGap() {
  return runFlow({
    sourceText: sampleBindleSource({
      extraBranch: `
  if (includeAudit) {
    const auditLog = kv("auditLog");
    auditLog.set("deploy", { user: ctx.user.id });
  }`,
    }),
    define: defineSampleBindle,
  });
}

export async function runIfcAuthorFlowWithNarrowingFailure() {
  const permissionManifest = buildUsagePermissionManifest({
    bindle: SAMPLE_BINDLE_ID,
    resources: [
      {
        kind: "kv",
        name: "todos",
        port: "wasi:keyvalue",
        catalogVerbs: ["get", "set", "delete"],
        observedCalls: [{ verb: "get" }, { verb: "set" }],
        declaredAllow: ["get"],
      },
    ],
  });
  const failures = permissionManifest.resources.flatMap(
    (resource) => resource.capabilityContract.failures,
  );

  return {
    ok: failures.length === 0,
    phase: "permission-contract",
    failures,
  };
}

export async function writeSdkManifestIrArtifact(options = {}) {
  const result = options.result ?? await runIfcAuthorFlow();
  if (!result.ok) {
    throw new Error(
      `cannot write manifest IR artifact from failed author flow phase ${result.phase}`,
    );
  }

  const path = resolve(
    options.root ?? PACKAGE_ROOT,
    options.relativePath ?? SDK_MANIFEST_IR_ARTIFACT_RELATIVE_PATH,
  );
  const content = stableManifestJson(result.manifest);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);

  return {
    path,
    relativePath: options.relativePath ?? SDK_MANIFEST_IR_ARTIFACT_RELATIVE_PATH,
    content,
    contentType: SDK_MANIFEST_IR_CONTENT_TYPE,
    manifest: result.manifest,
    manifestHash: result.manifestHash,
    upload: {
      target: "ManifestIrRegistry",
      method: "POST",
      path: "/manifests",
      contentType: SDK_MANIFEST_IR_CONTENT_TYPE,
    },
  };
}

async function runFlow({ sourceText, define }) {
  const collection = collectBindleResources({
    bindleId: SAMPLE_BINDLE_ID,
    fileName: SAMPLE_FILE_NAME,
    sourceText,
    define,
    coverageEvaluator: (context) =>
      evaluateCollectionCoverage({
        sourceText: context.sourceText,
        observedResourceIds: [...context.observedResourceIds],
        observedBindKeys: [...context.observedBindKeys],
        fileName: context.fileName,
      }),
  });

  if (!collection.coverage.ok) {
    return {
      ok: false,
      phase: "collection-coverage",
      diagnostics: collection.coverage.diagnostics,
      collection,
    };
  }

  const xaa = inferConnectorScopes({
    sourceText,
    bindings: ASANA_BINDING,
    fileName: SAMPLE_FILE_NAME,
  });
  if (!xaa.ok) {
    return {
      ok: false,
      phase: "xaa-scope-inference",
      diagnostics: [...xaa.diagnostics, ...xaa.contractFailures],
      collection,
    };
  }

  const permissionManifest = buildUsagePermissionManifest({
    bindle: SAMPLE_BINDLE_ID,
    resources: permissionInputsFromManifest(collection.manifest),
  });
  const failures = permissionManifest.resources.flatMap(
    (resource) => resource.capabilityContract.failures,
  );
  if (failures.length > 0) {
    return {
      ok: false,
      phase: "permission-contract",
      failures,
      collection,
    };
  }

  const manifest = withExternalApps(collection.manifest, xaa.manifest.connectors);
  const validation = validateManifest(manifest);
  const generated = buildGeneratedSurface({ manifest, coverage: collection.coverage });
  const manifestHash = canonicalManifestHash(manifest);

  return {
    ok: true,
    manifest,
    manifestHash,
    validation,
    collection,
    permissionManifest,
    xaa,
    generated,
  };
}

function defineSampleBindle(collect) {
  const todos = collect.kv("todos");
  const uploads = collect.bucket("uploads");
  const jobs = collect.queue("jobs");
  const config = collect.secret("config");
  const api = collect.api("api", {
    bind: { todos, uploads, jobs, config },
  });

  api.route("POST", "/todos").route("GET", "/todos/:id");
  todos.get("todo-1");
  todos.set("todo-1", { title: "wire IfC flow" });
  uploads.read("todo-1/attachment");
  uploads.write("todo-1/attachment", new Uint8Array());
  jobs.enqueue({ todoId: "todo-1" });
  config.access("ASANA_PROJECT_ID");
}

function sampleBindleSource({ extraBranch = "" } = {}) {
  return `import { api, bucket, connector, kv, queue, secret as config } from "@hobo/bindles";

export function supportDesk(ctx, includeAudit = false) {
  const todos = kv("todos");
  const uploads = bucket("uploads");
  const jobs = queue("jobs");
  const appConfig = config("config");
  const http = api("api", { bind: { todos, uploads, jobs, config: appConfig } });
  const asana = connector("asana");

  http.route("POST", "/todos").route("GET", "/todos/:id");
  todos.get(ctx.todoId);
  todos.set(ctx.todoId, { title: ctx.title });
  uploads.read(ctx.attachmentKey);
  uploads.write(ctx.attachmentKey, ctx.attachment);
  jobs.enqueue({ todoId: ctx.todoId });
  appConfig.access("ASANA_PROJECT_ID");
  asana.tasks.create({ name: ctx.title });
${extraBranch}
  return http;
}
`;
}

function permissionInputsFromManifest(manifest) {
  return Object.entries(manifest.resources)
    .filter(([, resource]) => Array.isArray(resource.allow))
    .map(([name, resource]) => ({
      kind: resource.kind,
      name,
      port: resource.port,
      catalogVerbs: resource.allow,
      observedCalls: resource.allow.map((verb) => ({ verb })),
    }));
}

function withExternalApps(manifest, connectors) {
  return sortManifest({
    ...manifest,
    connectors,
  });
}

function buildGeneratedSurface({ manifest, coverage }) {
  const sources = codegenSourcesFromManifest({ manifest, coverage });
  const artifacts = generateSdkCodegenArtifacts({ sources });
  const bindings = artifactText(artifacts, "src/_generated/bindings.d.ts");

  return {
    artifacts,
    paths: artifacts.map((artifact) => artifact.path),
    codegenManifest: JSON.parse(
      artifactText(artifacts, ".hobo/generated/codegen-manifest.json"),
    ),
    typeCheck: checkGeneratedTypes({
      bindings,
      requiredResources: Object.fromEntries(
        Object.entries(manifest.resources)
          .filter(([, resource]) => Array.isArray(resource.allow))
          .map(([name, resource]) => [name, resource.allow]),
      ),
    }),
  };
}

function codegenSourcesFromManifest({ manifest, coverage }) {
  const allowScopes = Object.fromEntries(
    Object.entries(manifest.resources)
      .filter(([, resource]) => Array.isArray(resource.allow))
      .map(([name, resource]) => [name, [...resource.allow]]),
  );
  const bindingNames = Object.keys(allowScopes).sort();

  return {
    wit: {
      interfaces: [
        { name: "wasi:keyvalue", operations: ["get", "set"] },
        { name: "wasi:blobstore", operations: ["read", "write"] },
        { name: "hobo:queue", operations: ["enqueue"] },
        { name: "wasi:config", operations: ["access"] },
      ],
      records: [
        {
          name: "Todo",
          fields: [
            { name: "id", type: "string" },
            { name: "title", type: "string" },
          ],
        },
        {
          name: "TodoDraft",
          fields: [{ name: "title", type: "string" }],
        },
      ],
    },
    zodSchemas: {
      records: [
        {
          name: "Todo",
          fields: [
            { name: "id", type: "string" },
            { name: "title", type: "string" },
          ],
        },
        {
          name: "TodoDraft",
          fields: [{ name: "title", type: "string" }],
        },
      ],
    },
    allowScopes,
    bindleGraph: {
      components: [
        {
          name: "api",
          bindings: Object.fromEntries(bindingNames.map((name) => [name, name])),
        },
      ],
      api: [
        {
          path: "api.todos.create",
          kind: "mutation",
          name: "createTodo",
          input: "TodoDraft",
          returns: "Todo",
        },
        {
          path: "api.todos.list",
          kind: "query",
          name: "listTodos",
          returns: "Todo",
        },
      ],
      steps: [],
      workflows: [],
    },
    providerOptions: [],
    rawEscapes: [],
    coverage: {
      ok: coverage.ok,
      unobservedResources: coverage.unobservedDeclarations.map(
        (declaration) => declaration.resourceId,
      ),
    },
  };
}

function checkGeneratedTypes({ bindings, requiredResources }) {
  const missing = [];
  for (const [name, verbs] of Object.entries(requiredResources)) {
    const union = verbs.map((verb) => `"${verb}"`).join(" | ");
    const expected = `readonly ${name}: ${name === "uploads" ? "BlobClient" : "DataClient"}<"${name}", ${union}>;`;
    if (!bindings.includes(expected)) {
      missing.push(expected);
    }
  }
  if (/\bany\b/.test(bindings)) {
    missing.push("bindings.d.ts must not contain any");
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function artifactText(artifacts, path) {
  const artifact = artifacts.find((entry) => entry.path === path);
  if (!artifact) {
    throw new Error(`missing generated artifact ${path}`);
  }
  return artifact.content;
}

function sortManifest(manifest) {
  return sortKeys(manifest);
}

export function stableManifestJson(manifest) {
  return `${JSON.stringify(sortKeys(manifest), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])])
      .filter(([, entry]) => entry !== undefined),
  );
}

function isPlainObject(value) {
  return value != null && Object.prototype.toString.call(value) === "[object Object]";
}
