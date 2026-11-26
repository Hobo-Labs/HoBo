import { isJsonObject } from "./json.js";
import { createHash } from "node:crypto";

export class HoboWitError extends Error {
  constructor({ tag, message }) {
    super(message);
    this.name = "HoboWitError";
    this.tag = tag;
  }
}

export function lowerFluentBindle(fluent) {
  if (!fluent || !isJsonObject(fluent)) {
    throw new TypeError("fluent bindle input must be an object");
  }

  const declaredResources = new Set();
  for (const resource of fluent.resources ?? []) {
    if (resource.collectedAfterHandlers) continue;
    declaredResources.add(resource.name);
  }

  for (const handler of fluent.handlers ?? []) {
    if (!declaredResources.has(handler.resource)) {
      throw new Error(
        `IfC collection order violation: handler ${handler.resource} must be attached after resource declaration`,
      );
    }
  }

  const resources = sortByNameAndKind(fluent.resources ?? []).map((resource) =>
    lowerResource(resource),
  );
  const handlers = sortHandlers(fluent.handlers ?? []);
  const runtime = lowerRuntime(fluent.runtime);

  const manifest = {
    schema: "hobo.manifest/v1",
    bindle: fluent.bindle,
    resources: resources.map(({ manifest }) => manifest),
  };

  if (handlers.length > 0) {
    manifest.handlers = handlers;
  }
  if (runtime.steps.length > 0) {
    manifest.runtime = runtime;
  }

  const witCalls = [
    ...resources.flatMap(({ calls }) => calls),
    ...handlers.map((handler) => ({
      interface: "hobo:sdk/handlers",
      function: "attach-handler",
      args: handler,
    })),
    ...runtime.steps.map((step) => ({
      interface: "hobo:sdk/runtime",
      function: "declare-step",
      args: step,
    })),
  ];

  const manifestJson = canonicalJson(manifest);

  return {
    witCalls,
    manifest,
    manifestJson,
    manifestHash: `sha256:${sha256(manifestJson)}`,
  };
}

export function lowerCanonicalSdkProgram(manifest) {
  const normalizedManifest = {
    ...manifest,
    resources: sortByNameAndKind(manifest.resources ?? []),
  };
  if (manifest.handlers) {
    normalizedManifest.handlers = sortHandlers(manifest.handlers);
  }
  if (manifest.runtime) {
    normalizedManifest.runtime = lowerRuntime(manifest.runtime);
  }

  const witCalls = [
    ...normalizedManifest.resources.flatMap(manifestResourceCalls),
    ...(normalizedManifest.handlers ?? []).map((handler) => ({
      interface: "hobo:sdk/handlers",
      function: "attach-handler",
      args: handler,
    })),
    ...(normalizedManifest.runtime?.steps ?? []).map((step) => ({
      interface: "hobo:sdk/runtime",
      function: "declare-step",
      args: step,
    })),
  ];
  const manifestJson = canonicalJson(normalizedManifest);

  return {
    witCalls,
    manifest: normalizedManifest,
    manifestJson,
    manifestHash: `sha256:${sha256(manifestJson)}`,
  };
}

export function runLoweringConformance(corpus, lowerers, options = {}) {
  const cases = corpus.map((fixture) => {
    const typescript = lowerers.typescript(fixture);
    const canonical = lowerers.canonical(fixture);
    const status =
      canonicalJson(typescript.witCalls) === canonicalJson(canonical.witCalls) &&
      typescript.manifestJson === canonical.manifestJson
        ? "passed"
        : "failed";

    return { name: fixture.name, status };
  });

  return {
    suite: "@hobo/conformance/sdk/lowering-equivalence",
    corpusPath: options.corpusPath,
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    cases,
  };
}

export function assertThinIdiomLayer(files) {
  const violations = [];

  for (const file of files) {
    for (const specifier of importSpecifiers(file.source)) {
      if (isCloudProviderImport(specifier)) {
        violations.push({
          path: file.path,
          reason: "cloud/provider runtime import is not allowed in the idiom layer",
          match: specifier,
        });
      }
    }

    const hiddenDefault = /hiddenDefault\s*=\s*["']([^"']+)["']/.exec(file.source);
    if (hiddenDefault && isProviderDefaultValue(hiddenDefault[1])) {
      violations.push({
        path: file.path,
        reason: "provider default/credential logic is not allowed in the idiom layer",
        match: hiddenDefault[1],
      });
    }
  }

  return violations;
}

export function mapWitResultToTs(result) {
  if (Object.hasOwn(result, "ok")) {
    return result.ok;
  }
  if (Object.hasOwn(result, "err")) {
    throw new HoboWitError(result.err);
  }
  throw new TypeError("WIT result must contain ok or err");
}

export function mapTsCancellationToWitResult(signal) {
  if (!signal?.reason) {
    throw new TypeError("cancellation signal must include a reason");
  }

  return {
    err: {
      tag: "cancelled",
      message: signal.reason,
      deadlineMs: signal.deadlineMs,
      retry: "caller-owned",
    },
  };
}

export async function runAsyncSemanticsAnnex(events) {
  const declared = new Set();
  const observed = [];

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    await Promise.resolve();

    if (event.kind === "cancel") {
      return {
        ...mapTsCancellationToWitResult(event),
        observed,
      };
    }

    if (event.kind === "resource") {
      declared.add(event.name);
      observed.push(`resource:${event.name}`);
      continue;
    }

    if (event.kind === "handler") {
      if (!declared.has(event.resource)) {
        throw new Error(
          `async IfC order violation: handler ${event.resource} awaited before resource declaration`,
        );
      }
      observed.push(`handler:${event.resource}:${event.event}`);
      continue;
    }

    throw new Error(`unknown async annex event kind: ${event.kind}`);
  }

  return { ok: observed };
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function lowerResource(resource) {
  const manifest = {
    kind: resource.kind,
    name: resource.name,
  };
  const calls = [
    {
      interface: "hobo:sdk/resource-catalog",
      function: "declare-resource",
      args: { kind: resource.kind, name: resource.name },
    },
  ];

  const allow = lowerAllow(resource);
  if (allow.length > 0) {
    manifest.allow = allow;
    calls.push({
      interface: "hobo:sdk/resource-catalog",
      function: "allow-resource",
      args: {
        name: resource.name,
        verbs: allow.map((entry) => entry.verb),
        provenance: commonProvenance(allow),
      },
    });
  }

  const bind = [...(resource.bind ?? [])].sort();
  if (bind.length > 0) {
    manifest.bind = bind;
    for (const target of bind) {
      calls.push({
        interface: "hobo:sdk/resource-catalog",
        function: "bind-resource",
        args: { from: resource.name, to: target },
      });
    }
  }

  const providerOptions = sortProviderOptions(resource.options ?? []);
  if (providerOptions.length > 0) {
    manifest.providerOptions = providerOptions;
    for (const option of providerOptions) {
      calls.push({
        interface: "hobo:sdk/provider-options",
        function: "annotate-provider-option",
        args: { name: resource.name, ...option },
      });
    }
  }

  return { manifest, calls };
}

function manifestResourceCalls(resource) {
  const calls = [
    {
      interface: "hobo:sdk/resource-catalog",
      function: "declare-resource",
      args: { kind: resource.kind, name: resource.name },
    },
  ];

  if (resource.allow) {
    calls.push({
      interface: "hobo:sdk/resource-catalog",
      function: "allow-resource",
      args: {
        name: resource.name,
        verbs: resource.allow.map((entry) => entry.verb),
        provenance: commonProvenance(resource.allow),
      },
    });
  }

  for (const target of resource.bind ?? []) {
    calls.push({
      interface: "hobo:sdk/resource-catalog",
      function: "bind-resource",
      args: { from: resource.name, to: target },
    });
  }

  for (const option of resource.providerOptions ?? []) {
    calls.push({
      interface: "hobo:sdk/provider-options",
      function: "annotate-provider-option",
      args: { name: resource.name, ...option },
    });
  }

  return calls;
}

function lowerAllow(resource) {
  const used = new Set(resource.methodsUsed ?? []);
  const declared = resource.allow ?? resource.methodsUsed ?? [];

  return [...new Set(declared)]
    .sort()
    .map((verb) => ({
      provenance: used.has(verb) ? "declared-narrow-or-equal" : "declared-dynamic",
      verb,
    }));
}

function lowerRuntime(runtime = {}) {
  return {
    steps: [...(runtime.steps ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

function sortByNameAndKind(resources) {
  return [...resources].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
}

function sortHandlers(handlers) {
  return [...handlers].sort(
    (left, right) =>
      left.resource.localeCompare(right.resource) ||
      left.event.localeCompare(right.event) ||
      left.exportName.localeCompare(right.exportName),
  );
}

function sortProviderOptions(options) {
  return [...options]
    .map((option) => ({
      option: option.option,
      provider: option.provider,
      value: option.value,
    }))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.option.localeCompare(right.option),
    );
}

function commonProvenance(entries) {
  const provenances = new Set(entries.map((entry) => entry.provenance));
  return provenances.size === 1 ? entries[0].provenance : "mixed";
}

function importSpecifiers(source) {
  const specifiers = [];
  const importPattern = /\bimport\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  let match;

  while ((match = importPattern.exec(source)) !== null) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function isCloudProviderImport(specifier) {
  return [
    /^@aws-sdk\//,
    /^aws-sdk$/,
    /^@azure\//,
    /^@google-cloud\//,
    /^@pulumi\//,
    /^cloudflare$/,
    /^terraform$/,
  ].some((pattern) => pattern.test(specifier));
}

function isProviderDefaultValue(value) {
  return /^(us-east-\d|us-west-\d|eastus|westus|AWS_|AZURE_|GOOGLE_)/.test(value);
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
