import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const NFR020_SCHEMA = "hobo.conformance.nfr020-boundary-lint/v1";

export const AGNOSTIC_CORE_PACKAGES = Object.freeze([
  "packages/core",
]);

export const AGNOSTIC_SDK_PACKAGES = Object.freeze([
  "packages/bindles",
  "packages/runtime",
  "packages/wit",
]);

export const AGNOSTIC_PACKAGES = Object.freeze([
  ...AGNOSTIC_CORE_PACKAGES,
  ...AGNOSTIC_SDK_PACKAGES,
]);

export type WorkspaceEdge = {
  readonly from: string;
  readonly to: string;
};

export type PackageKind =
  | "core"
  | "sdk"
  | "contract"
  | "adapter"
  | "package"
  | "external"
  | "unknown";

export type PackageClassification = {
  kind: PackageKind;
  layer: number;
};

const KNOWN_PACKAGE_PATHS = new Set([
  "packages/core",
  "packages/wit",
  "packages/bindles",
  "packages/runtime",
  "packages/componentize",
  "packages/conformance",
  "packages/cli",
]);

function isWorkspacePath(path: string): boolean {
  return path.startsWith("packages/") || path.startsWith("examples/");
}

export function classifyPackage(path: string): PackageClassification {
  if (!path.startsWith("packages/") && !path.startsWith("examples/")) {
    return { kind: "external", layer: 0 };
  }

  if (path === "packages/core") {
    return { kind: "core", layer: 0 };
  }

  if (AGNOSTIC_SDK_PACKAGES.includes(path)) {
    return { kind: "sdk", layer: 1 };
  }

  if (
    path.startsWith("packages/providers/") ||
    path.startsWith("packages/iac/") ||
    path.startsWith("packages/build/") ||
    path.startsWith("packages/runtimes/")
  ) {
    return { kind: "adapter", layer: 2 };
  }

  if (KNOWN_PACKAGE_PATHS.has(path)) {
    return { kind: "package", layer: path.startsWith("examples/") ? 4 : 3 };
  }

  if (path.startsWith("examples/")) {
    return { kind: "package", layer: 4 };
  }

  return { kind: "unknown", layer: Number.POSITIVE_INFINITY };
}

export function parseWorkspaceEdge(input: JsonValue): WorkspaceEdge {
  if (!isJsonObject(input) || input === null) {
    throw new Error("workspace edge must be an object");
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const record = input as JsonObject;
  const from = record.from;
  const to = record.to;

  if (!isJsonString(from) || from.length === 0) {
    throw new Error("workspace edge from must be a non-empty string");
  }

  if (!isJsonString(to) || to.length === 0) {
    throw new Error("workspace edge to must be a non-empty string");
  }

  const fromClass = classifyPackage(from);
  const toClass = classifyPackage(to);

  if (fromClass.kind === "unknown" && isWorkspacePath(from)) {
    throw new Error(`unknown import source ${from}`);
  }

  if (toClass.kind === "unknown" && isWorkspacePath(to)) {
    throw new Error(`unknown import target ${to}`);
  }

  return { from, to };
}

export type BoundaryLintResult = {
  ok: boolean;
  errors: string[];
  schema: string;
};

export function validateNfr020BoundaryImports(
  edges: readonly WorkspaceEdge[],
  extra: readonly WorkspaceEdge[] = [],
): BoundaryLintResult {
  const errors: string[] = [];
  const imports = [...edges, ...extra];

  for (const edge of imports) {
    const from = classifyPackage(edge.from);
    const to = classifyPackage(edge.to);

    if (from.kind === "unknown") {
      errors.push(`unknown import source ${edge.from}`);
      continue;
    }

    if (to.kind === "unknown") {
      errors.push(`unknown import target ${edge.to}`);
      continue;
    }

    if (
      (from.kind === "core" || from.kind === "sdk") &&
      to.kind === "adapter"
    ) {
      errors.push(
        `NFR-020: agnostic ${from.kind} package must not import provider/adapter: ${edge.from} -> ${edge.to}`,
      );
    }

    if (from.kind === "core" && to.kind !== "external") {
      errors.push(
        `core must not import HoBo packages: ${edge.from} -> ${edge.to}`,
      );
    }

    if (
      from.kind === "adapter" &&
      to.kind === "adapter" &&
      edge.from !== edge.to
    ) {
      errors.push(
        `adapters must not import each other: ${edge.from} -> ${edge.to}`,
      );
    }

    if (
      from.kind === "adapter" &&
      to.kind !== "core" &&
      edge.from !== edge.to
    ) {
      errors.push(
        `adapters may import only core ports: ${edge.from} -> ${edge.to}`,
      );
    }

    if (to.layer > from.layer) {
      errors.push(`dependency points outward: ${edge.from} -> ${edge.to}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    schema: NFR020_SCHEMA,
  };
}

export const canonicalAgnosticEdges: readonly WorkspaceEdge[] = [
  { from: "packages/bindles", to: "packages/core" },
  { from: "packages/bindles", to: "packages/wit" },
  { from: "packages/runtime", to: "packages/core" },
  { from: "packages/conformance", to: "packages/core" },
];

export const seededProviderLeakEdge: WorkspaceEdge = {
  from: "packages/bindles",
  to: "packages/providers/provider-aws",
};
