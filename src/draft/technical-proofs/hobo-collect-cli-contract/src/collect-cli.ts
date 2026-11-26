import { isJsonObject } from "./json.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { evaluateCollectionCoverage } from "../../collection-coverage-gate-contract/src/collection-coverage-gate.js";
import { collectBindleResources } from "../../resource-collection-engine-contract/src/resource-collection-engine.js";

export const HOBO_COLLECT_CLI_CONTRACT_VERSION = "hobo.collect-cli/v1";

export class CollectCliError extends Error {
  constructor(code, message, detail = {}, exitCode = 1) {
    super(message);
    this.name = "CollectCliError";
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

export function createHoboCollectCli({ project, engine = collectBindleResources } = {}) {
  const collectProject = project ?? sampleCollectProject();

  return Object.freeze({
    async run(argv, runOptions = {}) {
      let request = {
        json: argv.includes("--json"),
        out: null,
        camp: null,
        cwd: resolve(runOptions.cwd ?? process.cwd()),
      };

      try {
        request = parseCollectArgv(argv, request.cwd);
        const result = await executeCollect({ project: collectProject, engine, request });
        return renderSuccess(request, result);
      } catch (error) {
        return renderFailure(request, error, collectProject);
      }
    },
  });
}

export async function executeCollect({ project, engine, request }) {
  if (project.guestLanguage !== "ts") {
    throw new CollectCliError(
      "HOBO_COLLECT_STATIC_ANALYSIS_REQUIRED",
      `static analysis required for non-TypeScript guest "${project.guestLanguage}"`,
      { guestLanguage: project.guestLanguage },
    );
  }

  const collection = engine({
    bindleId: project.bindleId,
    fileName: project.fileName,
    sourceText: project.sourceText,
    define: project.define,
    ...(project.sourceText
      ? {
          coverageEvaluator: (context) =>
            evaluateCollectionCoverage({
              sourceText: context.sourceText,
              observedResourceIds: [...context.observedResourceIds],
              observedBindKeys: [...context.observedBindKeys],
              fileName: context.fileName,
            }),
        }
      : undefined),
  });
  const status = collection.coverage.ok ? "complete" : "coverage-incomplete";
  const envelope = {
    ok: true,
    command: "collect",
    contract: HOBO_COLLECT_CLI_CONTRACT_VERSION,
    status,
    manifestHash: collection.manifestHash,
    camp: request.camp ?? project.camp ?? null,
    manifest: collection.manifest,
    collection: {
      coverageComplete: collection.coverage.ok,
      status: collection.coverage.status,
      observedResourceIds: collection.coverage.observedResourceIds,
      observedBindKeys: collection.coverage.observedBindKeys,
      diagnostics: collection.coverage.diagnostics.map(publicDiagnostic),
    },
    secretRefs: normalizeSecretRefs(project.secretRefs ?? []),
    out: request.out,
  };

  if (request.out) {
    await mkdir(dirname(request.out), { recursive: true });
    await writeFile(request.out, stableStringify(envelope.manifest));
  }

  return envelope;
}

export function sampleCollectProject(options = {}) {
  const includeStaticUnhitBranch = options.includeStaticUnhitBranch === true;
  const sourceText = `import { api, bucket, kv } from "@hobo/bindles";

export default function collectSnapshot(includeDead = false) {
  const catalog = kv("catalog");
  catalog.get("photo-1");
  catalog.set("photo-1", { title: "ship" });

  const images = bucket("images");
  images.read("photo-1.jpg");
  images.write("photo-1.jpg", "bytes");

  const apiResource = api("api", { bind: { catalog, images } });
  apiResource.route("GET", "/photos/:id");
${includeStaticUnhitBranch ? "\n  if (includeDead) {\n    kv(\"dead-cache\");\n  }\n" : ""}
}
`;

  return {
    bindleId: "snapshop",
    fileName: "snapshop.ts",
    guestLanguage: options.guestLanguage ?? "ts",
    sourceText,
    secretRefs: options.secretRefs ?? [],
    define:
      options.define ??
      ((collect) => {
        const catalog = collect.kv("catalog");
        catalog.get("photo-1");
        catalog.set("photo-1", { title: "ship" });

        const images = collect.bucket("images");
        images.read("photo-1.jpg");
        images.write("photo-1.jpg", "bytes");

        const api = collect.api("api", { bind: { catalog, images } });
        api.route("GET", "/photos/:id");
      }),
  };
}

export function stableStringify(value) {
  return `${JSON.stringify(toStableValue(value), null, 2)}\n`;
}

function parseCollectArgv(argv, cwd) {
  const request = {
    json: false,
    out: null,
    camp: null,
    cwd,
  };
  let sawVerb = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "collect" && !sawVerb) {
      sawVerb = true;
      continue;
    }
    if (token === "--json") {
      request.json = true;
      continue;
    }
    if (token === "--out") {
      request.out = resolve(cwd, takeValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--camp") {
      request.camp = takeValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new CollectCliError("HOBO_COLLECT_USAGE", collectHelp(), {}, 0);
    }

    throw new CollectCliError(
      "HOBO_COLLECT_USAGE",
      `Unknown hobo collect option "${token}".`,
      { option: token },
      2,
    );
  }

  return request;
}

function renderSuccess(request, envelope) {
  if (request.json) {
    return {
      exitCode: 0,
      stdout: stableStringify(envelope),
      stderr: "",
    };
  }

  const heading =
    envelope.status === "complete"
      ? "hobo collect manifest"
      : "COLLECTION INCOMPLETE - manifest requires coverage diagnostics";
  const diagnostics =
    envelope.collection.diagnostics.length > 0
      ? `\nDiagnostics:\n${envelope.collection.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`).join("\n")}\n`
      : "";
  const out = envelope.out ? `\nWrote manifest: ${envelope.out}\n` : "";

  const camp = envelope.camp ? `\ncamp: ${envelope.camp}` : "";

  return {
    exitCode: 0,
    stdout: `${heading}\nstatus: ${envelope.status}${camp}\nhash: ${envelope.manifestHash}${out}${diagnostics}\n${stableStringify(envelope.manifest)}`,
    stderr: "",
  };
}

function renderFailure(request, error, project) {
  const collectError =
    error instanceof CollectCliError
      ? error
      : new CollectCliError(
          "HOBO_COLLECT_FAILED",
          `${project.fileName ?? "project"}: ${error?.message ?? "collection failed"}`,
          {},
        );
  const envelope = {
    ok: false,
    command: "collect",
    code: collectError.code,
    message: collectError.message,
    partialManifest: false,
    detail: collectError.detail,
  };

  if (request.json) {
    return {
      exitCode: collectError.exitCode,
      stdout: stableStringify(envelope),
      stderr: "",
    };
  }

  return {
    exitCode: collectError.exitCode,
    stdout: collectError.exitCode === 0 ? collectError.message : "",
    stderr: collectError.exitCode === 0 ? "" : `${collectError.message}\n`,
  };
}

function publicDiagnostic(diagnostic) {
  return Object.fromEntries(
    Object.entries({
      code: diagnostic.code,
      severity: diagnostic.severity,
      resourceId: diagnostic.resourceId,
      bindKey: diagnostic.bindKey,
      branch: diagnostic.branch,
      fileName: diagnostic.fileName,
      line: diagnostic.line,
      message: diagnostic.message,
    }).filter(([, value]) => value !== undefined),
  );
}

function normalizeSecretRefs(secretRefs) {
  return secretRefs.map((secret) => ({
    name: String(secret.name),
    ref: String(secret.ref),
  }));
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CollectCliError("HOBO_COLLECT_USAGE", `Option "${flag}" requires a value.`, {}, 2);
  }
  return value;
}

function collectHelp() {
  return "Usage: hobo collect [--camp <name>] [--json] [--out <file>]\n";
}

function toStableValue(value) {
  if (Array.isArray(value)) {
    return value.map(toStableValue);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, toStableValue(entry)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
