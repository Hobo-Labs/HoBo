const REQUIRED_ROOT_SCRIPTS = ["build", "typecheck", "lint", "test"];

const REQUIRED_PACKAGE_PATHS = [
  "packages/core",
  "packages/wit",
  "packages/bindles",
  "packages/camps",
  "packages/yards",
  "packages/junctions",
  "packages/runtime",
  "packages/componentize",
  "packages/cli",
  "packages/conformance",
  "packages/registry",
  "packages/identity",
  "packages/mcp",
  "packages/sdk",
  "packages/agent-skills",
  "packages/hobo-code",
  "packages/contracts",
  "packages/policy",
  "packages/evals",
  "packages/training",
  "packages/runtimes/runtime-local",
  "packages/providers/provider-aws",
  "packages/providers/provider-azure",
  "packages/iac/iac-pulumi",
  "packages/build/build-wasm",
  "examples/hello-bindle",
];

const packageNameByPath = new Map(
  REQUIRED_PACKAGE_PATHS.map((path) => [path, toPackageName(path)]),
);

export const canonicalSkeleton = {
  workspace: {
    packageManager: "pnpm@9.15.0",
    taskRunner: "turbo",
    frozenInstallCommand: "pnpm install --frozen-lockfile",
    release: {
      changesetsRequired: true,
      conventionalCommitsRequired: true,
    },
    scripts: {
      build: "turbo run build",
      typecheck: "turbo run typecheck",
      lint: "turbo run lint",
      test: "turbo run test",
    },
  },
  packages: REQUIRED_PACKAGE_PATHS.map((path) => ({
    path,
    name: packageNameByPath.get(path),
    scripts: {
      build: "node -e \"process.exit(0)\"",
    },
  })),
  imports: [
    { from: "packages/bindles", to: "packages/core" },
    { from: "packages/bindles", to: "packages/wit" },
    { from: "packages/runtime", to: "packages/core" },
    { from: "packages/cli", to: "packages/core" },
    { from: "packages/cli", to: "packages/runtime" },
    { from: "packages/providers/provider-aws", to: "packages/core" },
    { from: "packages/providers/provider-azure", to: "packages/core" },
    { from: "packages/iac/iac-pulumi", to: "packages/core" },
    { from: "packages/build/build-wasm", to: "packages/core" },
    { from: "packages/runtimes/runtime-local", to: "packages/core" },
    { from: "examples/hello-bindle", to: "packages/bindles" },
  ],
};

export function validateMonorepoSkeleton(skeleton) {
  const errors = [];
  const packagePaths = new Set(skeleton.packages?.map((entry) => entry.path) ?? []);
  const rootScripts = skeleton.workspace?.scripts ?? {};

  if (!skeleton.workspace?.packageManager?.startsWith("pnpm@")) {
    errors.push("workspace packageManager must pin pnpm");
  }

  if (skeleton.workspace?.taskRunner !== "turbo") {
    errors.push("workspace taskRunner must be turbo");
  }

  if (skeleton.workspace?.frozenInstallCommand !== "pnpm install --frozen-lockfile") {
    errors.push("workspace must document frozen-lockfile install");
  }

  if (skeleton.workspace?.release?.changesetsRequired !== true) {
    errors.push("workspace must require changesets for release intent");
  }

  if (skeleton.workspace?.release?.conventionalCommitsRequired !== true) {
    errors.push("workspace must require conventional commits");
  }

  for (const scriptName of REQUIRED_ROOT_SCRIPTS) {
    if (!rootScripts[scriptName]) {
      errors.push(`missing root ${scriptName} script`);
    }
  }

  for (const packagePath of REQUIRED_PACKAGE_PATHS) {
    if (!packagePaths.has(packagePath)) {
      errors.push(`missing required package ${packagePath}`);
    }
  }

  for (const entry of skeleton.packages ?? []) {
    if (!entry.scripts?.build) {
      errors.push(`${entry.path} must be a placeholder package that builds`);
    }
  }

  errors.push(...validateBoundaryImports(skeleton.imports).errors);
  errors.push(...detectWorkspaceCycles(skeleton.imports).errors);

  return {
    errors,
    summary: {
      packageManager: "pnpm",
      packageCount: packagePaths.size,
      requiredPackages: [...REQUIRED_PACKAGE_PATHS],
      requiredScripts: [...REQUIRED_ROOT_SCRIPTS],
    },
  };
}

export function validateBoundaryImports(baseImports = [], extraImports = []) {
  const errors = [];
  const imports = [...baseImports, ...extraImports];

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

    if (from.kind === "core" && to.kind !== "external") {
      errors.push(`core must not import HoBo packages: ${edge.from} -> ${edge.to}`);
    }

    if (from.kind === "adapter" && to.kind === "adapter" && edge.from !== edge.to) {
      errors.push(`adapters must not import each other: ${edge.from} -> ${edge.to}`);
    }

    if (from.kind === "adapter" && to.kind !== "core" && edge.from !== edge.to) {
      errors.push(`adapters may import only core ports: ${edge.from} -> ${edge.to}`);
    }

    if (to.layer > from.layer) {
      errors.push(`dependency points outward: ${edge.from} -> ${edge.to}`);
    }
  }

  return { errors };
}

export function detectWorkspaceCycles(imports = []) {
  const graph = new Map();
  const errors = [];

  for (const { from, to } of imports) {
    if (!graph.has(from)) {
      graph.set(from, []);
    }
    graph.get(from).push(to);
  }

  const visiting = new Set();
  const visited = new Set();

  const visit = (node, trail) => {
    if (visiting.has(node)) {
      const cycle = trail.slice(trail.indexOf(node)).join(" -> ");
      errors.push(`workspace dependency cycle: ${cycle}`);
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      visit(next, [...trail, next]);
    }
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.keys()) {
    visit(node, [node]);
  }

  return { errors };
}

function classifyPackage(path) {
  if (!path?.startsWith("packages/") && !path?.startsWith("examples/")) {
    return { kind: "external", layer: 0 };
  }

  if (path === "packages/core") {
    return { kind: "core", layer: 0 };
  }

  if (path === "packages/wit") {
    return { kind: "contract", layer: 1 };
  }

  if (
    path.startsWith("packages/providers/") ||
    path.startsWith("packages/iac/") ||
    path.startsWith("packages/build/") ||
    path.startsWith("packages/runtimes/")
  ) {
    return { kind: "adapter", layer: 2 };
  }

  if (packageNameByPath.has(path)) {
    return { kind: "package", layer: path.startsWith("examples/") ? 4 : 3 };
  }

  return { kind: "unknown", layer: Number.POSITIVE_INFINITY };
}

function toPackageName(path) {
  if (path.startsWith("examples/")) {
    return `@hobo/example-${path.split("/").at(-1)}`;
  }

  return `@hobo/${path.split("/").at(-1)}`;
}
