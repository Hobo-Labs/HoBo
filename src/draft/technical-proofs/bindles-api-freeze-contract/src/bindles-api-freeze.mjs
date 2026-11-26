import { validateManifest } from "../../hobo-manifest-contract/src/manifest.js";
import * as catalogModule from "../../hobo-bindles-resource-catalog/src/catalog.js";
import { buildUsagePermissionManifest } from "../../usage-inferred-permissions-contract/src/usage-permissions.js";
import { evaluateCollectionCoverage } from "../../collection-coverage-gate-contract/src/collection-coverage-gate.js";
import { createConnectorBinding } from "../../connector-authoring-contract/src/connector-authoring.mjs";
import { inferConnectorScopes } from "../../../exp-proofs/api/xaa-scope-inference-contract/src/xaa-scope-inference.mjs";
import { createRawView } from "../../raw-driver-escape-hatch-contract/src/raw-driver-escape-hatch.js";
import { isJsonString, isJsonObject } from "./json.js";

const SNAPSHOT_VERSION = "hobo.bindles.public-api/v1";
const FORBIDDEN_PUBLIC_SYMBOL = /aws|azure|gcp|cloudflare|rds|fargate|cosmos|internal|cloud/i;
const ASANA_AUTH_JSON = Object.freeze({
  flows: Object.freeze([
    Object.freeze({
      type: "oauth2-xaa",
      idJag: true,
      audience: "https://app.asana.com",
      scopes: Object.freeze(["projects:read", "tasks:read", "tasks:write"]),
      operations: Object.freeze({
        "projects.list": Object.freeze({ scope: "projects:read" }),
        "tasks.create": Object.freeze({ scope: "tasks:write" }),
        "tasks.get": Object.freeze({ scope: "tasks:read" }),
      }),
    }),
  ]),
});

export class ApiFreezeError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "ApiFreezeError";
    this.code = code;
    this.details = details;
  }
}

export function createBindlesPublicApiSnapshot(bindles = catalogModule) {
  const factoryNames = bindles.CATALOG.map((entry) => entry.factory);
  const knownExports = new Set(["CATALOG", "catalogFactoryNames", "secretRef", ...factoryNames]);
  const factoryExports = bindles.CATALOG.map((entry) => ({
    name: entry.factory,
    kind: bindles[entry.factory] instanceof Function ? "resource-factory" : "missing-resource-factory",
    signature:
      bindles[entry.factory] instanceof Function
        ? `${entry.factory}(name: string): ResourceHandle<"${entry.factory}", ${allowUnion(entry.allowVerbs)}>`
        : `${entry.factory}: missing`,
    portRef: [...entry.portRef],
    allowVerbs: [...entry.allowVerbs],
  }));
  const extraExports = Object.keys(bindles)
    .filter((name) => !knownExports.has(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      kind: "unclassified-public-export",
      signature: `${name}: unknown`,
    }));

  return deepFreeze({
    package: "@hobo/bindles",
    version: SNAPSHOT_VERSION,
    resourceHandleSignature: {
      allow: "allow(...verbs: AllowVerb[]): ResourceHandle<Kind, NarrowedAllow>",
      descriptor: "toDescriptor(): ResourceDescriptor<Kind>",
      identity: "readonly identity: { kind: Kind; name: string; stableId: string }",
    },
    exports: [
      {
        name: "CATALOG",
        kind: "readonly-catalog",
        signature: "readonly ResourceCatalogEntry[]",
      },
      ...factoryExports,
      {
        name: "catalogFactoryNames",
        kind: bindles.catalogFactoryNames instanceof Function ? "catalog-helper" : "missing-helper",
        signature:
          bindles.catalogFactoryNames instanceof Function
            ? "catalogFactoryNames(): readonly string[]"
            : "catalogFactoryNames: missing",
      },
      {
        name: "secretRef",
        kind: bindles.secretRef instanceof Function ? "helper" : "missing-helper",
        signature: bindles.secretRef instanceof Function ? "secretRef(ref: string): SecretRef" : "secretRef: missing",
      },
      ...extraExports,
    ],
  });
}

export function assertPublicApiSnapshot(actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ApiFreezeError(
      "BINDLES_API_SNAPSHOT_MISMATCH",
      "public @hobo/bindles API changed; update the snapshot deliberately if this is intended",
      {
        actualExportNames: (actual.exports ?? []).map((entry) => entry.name),
        expectedExportNames: (expected.exports ?? []).map((entry) => entry.name),
      },
    );
  }

  return actual;
}

export function assertNoInternalCloudSymbols(snapshot) {
  const leaks = [];
  visitStrings(snapshot, "$", (value, path) => {
    if (FORBIDDEN_PUBLIC_SYMBOL.test(value)) {
      leaks.push({ path, value });
    }
  });

  if (leaks.length > 0) {
    throw new ApiFreezeError(
      "BINDLES_API_INTERNAL_SYMBOL_LEAK",
      "public @hobo/bindles API snapshot exposes internal or provider-specific symbols",
      { leaks },
    );
  }

  return snapshot;
}

export function evaluateBindlesFreezeMatrix() {
  const cases = [
    evaluateAllowNarrowBelowUsage(),
    evaluateCollectionCoverageGap(),
    evaluateXaaLeastPrivilege(),
    evaluateXaaNarrowOverride(),
    evaluateRawNonPortableFlag(),
    evaluateProviderWithInert(),
    evaluateCombinedNarrowingCoverage(),
  ];

  return deepFreeze({
    ok: cases.every((entry) => entry.ok),
    cases,
  });
}

export function createRepresentativeManifest() {
  return deepFreeze({
    schema: "hobo.manifest/v1",
    componentHost: {
      kind: "wasmtime",
      version: "1.0.0",
    },
    resources: {
      store: {
        type: "data.v1",
        port: "hobo:data",
        allow: ["query", "read"],
        driver: "postgres",
      },
      api: {
        type: "component.v1",
        image:
          "oci://registry.example.com/hobo399/api@sha256:1111111111111111111111111111111111111111111111111111111111111111",
        runtime: "wasi-preview2",
        exports: ["wasi:http/incoming-handler"],
        links: [
          {
            import: "hobo:data",
            to: "store",
            allow: ["query", "read"],
          },
        ],
        env: {
          ConnectionStrings__store: "{store.connectionString}",
        },
        annotations: {
          providerWith: [
            {
              provider: "aws",
              option: "fargate",
              active: true,
              config: {
                cpu: 512,
                memoryMiB: 1024,
              },
            },
            {
              provider: "azure",
              option: "containerApps",
              active: false,
              config: {
                scale: 1,
              },
            },
          ],
          rawEdges: [
            {
              code: "RAW_DRIVER_ESCAPE_HATCH",
              driver: "postgres",
              projection: "ticket_projection",
              readOnly: true,
              satisfiedBy: ["postgres"],
            },
          ],
        },
      },
      site: {
        type: "website.v1",
        bind: ["api"],
      },
    },
    connectors: {
      asana: {
        type: "connector.v1",
        via: "xaa",
        audience: "https://app.asana.com",
        onBehalfOf: "user",
        allow: ["tasks:write"],
        observedScopes: ["tasks:write"],
        requestedScopeSource: "usage-inferred",
      },
    },
  });
}

export function assertManifestFreeze(actual, expected) {
  validateManifest(actual);
  validateManifest(expected);

  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ApiFreezeError(
      "MANIFEST_IR_SNAPSHOT_MISMATCH",
      "representative hobo.manifest/v1 shape changed; update the golden deliberately if intended",
      { changedPaths: diffPaths(expected, actual) },
    );
  }

  return actual;
}

export function assertSchemaVersionBumpForContractChange(previous, candidate) {
  const changedPaths = contractDiffPaths(previous, candidate);
  if (changedPaths.length > 0 && previous.schema === candidate.schema) {
    throw new ApiFreezeError(
      "MANIFEST_SCHEMA_VERSION_REQUIRED",
      "manifest shape changed without a schema version bump",
      { schema: candidate.schema, changedPaths },
    );
  }

  return {
    ok: true,
    changedPaths,
    schemaChanged: previous.schema !== candidate.schema,
  };
}

export function resolveProviderWithOptions({ resourceId, selectedProvider, providerOptions }) {
  assertNonEmptyString(resourceId, "resourceId");
  assertNonEmptyString(selectedProvider, "selectedProvider");
  if (!Array.isArray(providerOptions)) {
    throw new TypeError("providerOptions must be an array");
  }

  const manifestEntries = providerOptions.map((entry) => {
    assertNonEmptyString(entry.provider, "provider");
    assertNonEmptyString(entry.option, "option");
    return {
      provider: entry.provider,
      option: entry.option,
      active: entry.provider === selectedProvider,
      config: clone(entry.config ?? {}),
    };
  });
  const applied = manifestEntries.find((entry) => entry.active);
  if (!applied) {
    throw new ApiFreezeError(
      "PROVIDER_WITH_SELECTED_PROVIDER_MISSING",
      "selected provider has no matching .with() option block",
      { resourceId, selectedProvider },
    );
  }

  return deepFreeze({
    resourceId,
    selectedProvider,
    applied,
    inert: manifestEntries.filter((entry) => !entry.active),
    manifest: {
      resourceId,
      providerWith: manifestEntries,
    },
  });
}

function evaluateAllowNarrowBelowUsage() {
  const manifest = buildUsagePermissionManifest({
    bindle: "freeze-narrowing",
    resources: [
      {
        kind: "kv",
        name: "todos",
        port: "wasi:keyvalue",
        catalogVerbs: ["delete", "get", "set"],
        observedCalls: [{ verb: "get" }, { verb: "set" }],
        declaredAllow: ["get"],
      },
    ],
  });
  const failures = manifest.resources[0].capabilityContract.failures;
  const assertedCodes = failures.map((entry) => entry.code);

  return {
    name: "allow-narrow-below-usage",
    ok: assertedCodes.includes("capability.required-not-granted"),
    status: "failed-as-expected",
    assertedCodes,
    manifest,
  };
}

function evaluateCollectionCoverageGap() {
  const result = evaluateCollectionCoverage({
    sourceText: [
      'import { kv } from "@hobo/bindles";',
      'const todos = kv("todos");',
      'if (featureFlag("audit")) {',
      '  const audit = kv("audit");',
      "  audit.get('last-run');",
      "}",
      "todos.get('next');",
    ].join("\n"),
    observedResourceIds: ["todos"],
    fileName: "freeze-coverage.bindle.ts",
  });
  const assertedCodes = result.diagnostics.map((entry) => entry.code);

  return {
    name: "collection-coverage-gap",
    ok: result.ok === false && assertedCodes.includes("collection.coverage.unobserved-resource"),
    status: "failed-as-expected",
    assertedCodes,
    diagnostics: result.diagnostics,
  };
}

function evaluateXaaLeastPrivilege() {
  const result = inferConnectorScopes({
    sourceText: [
      'const asana = connector("asana");',
      "await asana.tasks.create({ name: 'ship freeze' });",
    ].join("\n"),
    bindings: {
      asana: createConnectorBinding("asana", ASANA_AUTH_JSON),
    },
  });

  return {
    name: "xaa-least-privilege",
    ok: result.ok === true && arraysEqual(result.manifest.connectors.asana.allow, ["tasks:write"]),
    status: "satisfied",
    assertedCodes: [],
    manifest: result.manifest,
  };
}

function evaluateXaaNarrowOverride() {
  const result = inferConnectorScopes({
    sourceText: [
      'const asana = connector("asana");',
      "await asana.tasks.create({ name: 'blocked by narrow allow' });",
    ].join("\n"),
    bindings: {
      asana: createConnectorBinding("asana", ASANA_AUTH_JSON).allow("tasks:read"),
    },
  });
  const assertedCodes = result.contractFailures.map((entry) => entry.code);

  return {
    name: "xaa-narrow-override",
    ok: result.ok === false && assertedCodes.includes("xaa.scope.exceeds-declared-allow"),
    status: "failed-as-expected",
    assertedCodes,
    contractFailures: result.contractFailures,
  };
}

function evaluateRawNonPortableFlag() {
  const rawPlan = createRawView({
    name: "ticket_projection",
    driver: "postgres",
    rawAccess: true,
    source: "projected",
  }).raw((driver) => driver.query("select * from tickets where id = $1", ["ticket-1"]));
  const assertedCodes = rawPlan.planWarnings.map((entry) => entry.code);

  return {
    name: "raw-non-portable",
    ok: assertedCodes.includes("RAW_DRIVER_PORTABILITY_DEBT"),
    status: "warned-as-expected",
    assertedCodes,
    planWarnings: rawPlan.planWarnings,
  };
}

function evaluateProviderWithInert() {
  const resolution = resolveProviderWithOptions({
    resourceId: "api",
    selectedProvider: "aws",
    providerOptions: [
      {
        provider: "aws",
        option: "fargate",
        config: {
          cpu: 512,
          memoryMiB: 1024,
        },
      },
      {
        provider: "azure",
        option: "containerApps",
        config: {
          scale: 1,
        },
      },
    ],
  });

  return {
    name: "provider-with-inert",
    ok: resolution.applied.provider === "aws" && resolution.inert.every((entry) => entry.active === false),
    status: "satisfied",
    assertedCodes: [],
    resolution,
  };
}

function evaluateCombinedNarrowingCoverage() {
  const narrowing = evaluateAllowNarrowBelowUsage();
  const coverage = evaluateCollectionCoverageGap();
  const assertedCodes = [...narrowing.assertedCodes, ...coverage.assertedCodes];

  return {
    name: "combined-narrowing-coverage",
    ok:
      assertedCodes.includes("capability.required-not-granted") &&
      assertedCodes.includes("collection.coverage.unobserved-resource"),
    status: "failed-as-expected",
    assertedCodes,
  };
}

function allowUnion(verbs) {
  if (verbs.length === 0) {
    return "never";
  }

  return verbs
    .toSorted((left, right) => left.localeCompare(right))
    .map((verb) => `"${verb}"`)
    .join(" | ");
}

function diffPaths(before, after, path = "") {
  if (canonicalJson(before) === canonicalJson(after)) {
    return [];
  }
  if (!isRecord(before) || !isRecord(after)) {
    return [path || "$"];
  }

  const paths = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in before) || !(key in after)) {
      paths.push(childPath);
      continue;
    }
    paths.push(...diffPaths(before[key], after[key], childPath));
  }
  return paths;
}

function contractDiffPaths(before, after, path = "") {
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      return [path || "$"];
    }
    const paths = [];
    const maxLength = Math.max(before.length, after.length);
    for (let index = 0; index < maxLength; index += 1) {
      if (index >= before.length || index >= after.length) {
        paths.push(`${path}[${index}]`);
        continue;
      }
      paths.push(...contractDiffPaths(before[index], after[index], `${path}[${index}]`));
    }
    return paths;
  }
  if (!isRecord(before) || !isRecord(after)) {
    return Object.prototype.toString.call(before) === Object.prototype.toString.call(after) ? [] : [path || "$"];
  }

  const paths = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in before) || !(key in after)) {
      paths.push(childPath);
      continue;
    }
    paths.push(...contractDiffPaths(before[key], after[key], childPath));
  }
  return paths;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function visitStrings(value, path, visitor) {
  if (isJsonString(value)) {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitStrings(entry, `${path}[${index}]`, visitor));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      visitStrings(child, `${path}.${key}`, visitor);
    }
  }
}

function assertNonEmptyString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return isJsonObject(value);
}
