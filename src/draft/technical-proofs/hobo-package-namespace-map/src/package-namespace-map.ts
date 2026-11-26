export const PACKAGE_NAMESPACE_MAP = {
  "@hobo/bindles": {
    role: "app-authoring",
    owns: [
      "bindle",
      "allow",
      "with",
      "api",
      "auth",
      "database",
      "bucket",
      "objectStore",
      "kv",
      "queue",
      "topic",
      "flag",
      "experiment",
      "rollout",
      "slo",
      "trainable",
      "web",
      "websocket",
      "connector",
      "config",
      "secret",
      "secretRef",
      "env",
      "fromBinding"
    ],
    mustNotReexport: [
      "camp",
      "yard",
      "junction",
      "defineResource",
      "policyPack",
      "runbook",
      "dispatcher",
      "runner",
      "generateProvider",
      "chaos",
      "workflow",
      "step"
    ]
  },
  "@hobo/runtime": {
    role: "app-runtime",
    owns: [
      "workflow",
      "step",
      "handler",
      "cron",
      "sleep",
      "actor",
      "from",
      "start",
      "createHook",
      "training",
      "FatalError",
      "RetryableError"
    ]
  },
  "@hobo/data": {
    role: "app-data",
    owns: ["command", "view", "projection", "repo"]
  },
  "@hobo/events": {
    role: "app-events",
    owns: ["emit", "subscribe", "saga"]
  },
  "@hobo/camps": {
    role: "topology",
    owns: ["camp"]
  },
  "@hobo/yards": {
    role: "topology",
    owns: ["yard", "domain"]
  },
  "@hobo/junctions": {
    role: "topology",
    owns: ["junction"]
  },
  "@hobo/sdk": {
    role: "operator-sdk",
    owns: [
      "defineResource",
      "policyPack",
      "rule",
      "waiver",
      "dispatcher",
      "runner",
      "runbook",
      "generateProvider",
      "chaos"
    ]
  },
  "@hobo/core": {
    role: "shared-types",
    owns: []
  },
  "@hobo/wit": {
    role: "generated-wit-bindings",
    owns: []
  }
};

const ownership = new Map();

for (const [packageName, definition] of Object.entries(PACKAGE_NAMESPACE_MAP)) {
  for (const symbol of definition.owns) {
    const owners = ownership.get(symbol) ?? [];
    owners.push(packageName);
    ownership.set(symbol, owners);
  }
}

export function packageForSymbol(symbol, _context = {}) {
  const owners = ownership.get(symbol) ?? [];

  if (owners.length === 0) {
    return undefined;
  }

  if (owners.length > 1) {
    throw new Error(`${symbol} has multiple package owners; pass a context`);
  }

  return owners[0];
}

export function assertNoForbiddenReexport(packageName, exportedSymbols) {
  const forbidden = new Set(PACKAGE_NAMESPACE_MAP[packageName]?.mustNotReexport ?? []);
  return exportedSymbols.filter((symbol) => forbidden.has(symbol));
}

export function validateImportStatement({ from, symbols }) {
  const errors = [];

  for (const symbol of symbols) {
    const expectedPackage = packageForSymbol(symbol);
    if (expectedPackage !== undefined && expectedPackage !== from) {
      errors.push(`${symbol} must be imported from ${expectedPackage}, not ${from}`);
    }
  }

  return errors;
}

export function validateAgentImports(imports) {
  return imports
    .filter((entry) => entry.imported === "agent" && ["@hobo/runtime", "@hobo/sdk", "@hobo/bindles"].includes(entry.from))
    .map((entry) => `agent is not a public SDK factory; use connector(..., { protocol }) instead of importing from ${entry.from}`);
}
