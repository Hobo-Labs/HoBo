import { createHash } from "node:crypto";

const PACKAGE_RE = /^\s*package\s+([\w-]+:[\w-]+)(?:@([\w.+-]+))?\s*;/m;
const INTERFACE_RE = /^\s*interface\s+([\w-]+)\s*\{([\s\S]*?)^\s*\}/gm;
const WORLD_RE = /^\s*world\s+([\w-]+)\s*\{([\s\S]*?)^\s*\}/m;
const IMPORT_EXPORT_RE = /^\s*(import|export)\s+([\w-]+)\s*;/gm;
const FUNC_RE = /^\s*([\w-]+):\s*func\s*\(([^)]*)\)\s*(?:->\s*([^;]+))?;/gm;

export function extractWitContract(witSource) {
  const packageMatch = witSource.match(PACKAGE_RE);
  if (!packageMatch) {
    throw new Error("missing WIT package declaration");
  }

  const interfaces = {};
  for (const match of witSource.matchAll(INTERFACE_RE)) {
    const [, name, body] = match;
    const functions = [];

    for (const functionMatch of body.matchAll(FUNC_RE)) {
      functions.push({
        name: functionMatch[1],
        params: parseParams(functionMatch[2]),
        result: normalizeType(functionMatch[3] ?? "_"),
      });
    }

    interfaces[name] = { name, functions };
  }

  const worldMatch = witSource.match(WORLD_RE);
  if (!worldMatch) {
    throw new Error("missing WIT world declaration");
  }

  return normalizeContract({
    package: packageMatch[1],
    version: packageMatch[2] ?? null,
    world: worldMatch[1],
    interfaces,
    ...parseWorldEntries(worldMatch[2]),
  });
}

export function buildComponentManifest(contract, overrides = {}) {
  const normalized = normalizeContract(contract);
  const interfaces = overrides.interfaces ?? normalized.interfaces;
  const imports = overrides.imports ?? normalized.imports;
  const exports = overrides.exports ?? normalized.exports;

  return normalizeContract({
    package: normalized.package,
    version: normalized.version,
    world: normalized.world,
    interfaces,
    imports,
    exports,
  });
}

export function compareForwardReverse(declaredContract, extractedManifest) {
  const declared = normalizeContract(declaredContract);
  const extracted = normalizeContract(extractedManifest);
  const importDrift = compareInterfaceLists(declared.imports, extracted.imports);
  const exportDrift = compareInterfaceLists(declared.exports, extracted.exports);
  const signatureDrift = compareImportedSignatures(declared, extracted);
  const ok =
    importDrift.missing.length === 0 &&
    importDrift.extra.length === 0 &&
    exportDrift.missing.length === 0 &&
    exportDrift.extra.length === 0 &&
    signatureDrift.length === 0;

  return {
    ok,
    declared: surfaceDigest(declared),
    extracted: surfaceDigest(extracted),
    imports: importDrift,
    exports: exportDrift,
    signatureDrift,
  };
}

export function assertNoForwardReverseDrift(report) {
  if (report.ok) {
    return report;
  }

  const details = [
    formatList("missing imports", report.imports.missing),
    formatList("extra imports", report.imports.extra),
    formatList("missing exports", report.exports.missing),
    formatList("extra exports", report.exports.extra),
    formatList(
      "signature drift",
      report.signatureDrift.map((drift) => drift.interface),
    ),
  ].filter(Boolean);

  throw new Error(`forward/reverse WIT drift: ${details.join("; ")}`);
}

export function buildIdiomLayerSkeleton(report, options = {}) {
  assertNoForwardReverseDrift(report);

  const language = options.language ?? "typescript";
  const imports = report.extracted.imports
    .map((name) => {
      const functions = report.extracted.interfaces[name]?.functions ?? [];
      return [
        `// interface ${name}`,
        ...functions.map(
          (fn) =>
            `export function ${toIdentifier(fn.name)}() { throw new Error("implement lowering to ${name}.${fn.name}"); }`,
        ),
      ].join("\n");
    })
    .join("\n\n");

  return [
    `// Generated ${language} idiom-layer skeleton.`,
    `// Source contract: ${report.extracted.package}@${report.extracted.version ?? "unversioned"} world ${report.extracted.world}.`,
    "// Add ergonomic wrappers only; keep behavior in generated WIT bindings.",
    imports,
    "",
  ].join("\n");
}

export function reverseExtract({ declaredWit, componentManifest, language = "typescript" }) {
  const declared = extractWitContract(declaredWit);
  const extracted = componentManifest ?? buildComponentManifest(declared);
  const report = compareForwardReverse(declared, extracted);

  return {
    report,
    skeleton: report.ok ? buildIdiomLayerSkeleton(report, { language }) : null,
  };
}

function parseWorldEntries(worldBody) {
  const imports = [];
  const exports = [];

  for (const match of worldBody.matchAll(IMPORT_EXPORT_RE)) {
    const [, direction, name] = match;
    if (direction === "import") {
      imports.push(name);
    } else {
      exports.push(name);
    }
  }

  return { imports, exports };
}

function parseParams(params) {
  const trimmed = params.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed.split(",").map((param) => {
    const [name, ...typeParts] = param.trim().split(":");
    return {
      name: name.trim(),
      type: normalizeType(typeParts.join(":")),
    };
  });
}

function compareInterfaceLists(declared, extracted) {
  return {
    missing: declared.filter((name) => !extracted.includes(name)),
    extra: extracted.filter((name) => !declared.includes(name)),
  };
}

function compareImportedSignatures(declared, extracted) {
  const drift = [];
  for (const name of declared.imports.filter((importName) => extracted.imports.includes(importName))) {
    const declaredInterface = declared.interfaces[name];
    const extractedInterface = extracted.interfaces[name];

    if (!extractedInterface) {
      drift.push({ interface: name, reason: "missing extracted interface" });
      continue;
    }

    if (JSON.stringify(declaredInterface.functions) !== JSON.stringify(extractedInterface.functions)) {
      drift.push({ interface: name, reason: "function signatures differ" });
    }
  }

  return drift;
}

function normalizeContract(contract) {
  return {
    package: contract.package,
    version: contract.version ?? null,
    world: contract.world,
    interfaces: normalizeInterfaces(contract.interfaces ?? {}),
    imports: uniqueSorted(contract.imports ?? []),
    exports: uniqueSorted(contract.exports ?? []),
  };
}

function normalizeInterfaces(interfaces) {
  const normalized = {};
  for (const [name, details] of Object.entries(interfaces)) {
    normalized[name] = {
      name,
      functions: [...(details.functions ?? [])]
        .map((fn) => ({
          name: fn.name,
          params: (fn.params ?? []).map((param) => ({
            name: param.name,
            type: normalizeType(param.type),
          })),
          result: normalizeType(fn.result ?? "_"),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

function surfaceDigest(contract) {
  return {
    package: contract.package,
    version: contract.version,
    world: contract.world,
    imports: contract.imports,
    exports: contract.exports,
    interfaces: contract.interfaces,
    sha256: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
  };
}

function normalizeType(type) {
  return type.replace(/\s+/g, " ").trim();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function formatList(label, values) {
  return values.length > 0 ? `${label}: ${values.join(", ")}` : "";
}

function toIdentifier(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
