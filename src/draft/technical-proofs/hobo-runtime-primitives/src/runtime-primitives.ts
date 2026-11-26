import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIT_PATH = join(PACKAGE_ROOT, "wit", "world.wit");
const WIT_PACKAGE = "hobo:runtime";
const WIT_VERSION = "0.1.0";
const STABILITY = "preview";

export const EXPECTED_RUNTIME_INTERFACES = Object.freeze({
  workflow: iface(["run-step", "sleep", "emit", "create-hook", "start"]),
  actor: iface(["get-state", "append-state", "signal"]),
  saga: iface(["on", "emit", "compensate"]),
  agent: iface(["run", "tool", "token"]),
  command: iface(["execute", "emit"]),
  subscribe: iface(["subscribe", "snapshot"]),
});

export const SDK_PRIMITIVE_TABLE = Object.freeze([
  primitive("step", "workflow", "run-step", "memoized-step"),
  primitive("sleep", "workflow", "sleep", "durable-timer"),
  primitive("workflow", "workflow", "start", "deterministic-orchestration"),
  primitive("createHook", "workflow", "create-hook", "durable-resume-token"),
  primitive("actor", "actor", "append-state", "single-writer-event-fold"),
  primitive("signal", "actor", "signal", "at-least-once-idempotent-message"),
  primitive("saga", "saga", "on", "choreography-subscription"),
  primitive("compensate", "saga", "compensate", "durable-compensation"),
  primitive("agent", "agent", "run", "durable-agent-step"),
  primitive("tool", "agent", "tool", "tool-as-step"),
  primitive("token", "agent", "token", "brokered-token-handle"),
  primitive("command", "command", "execute", "aggregate-command"),
  primitive("emit", "command", "emit", "event-store-append"),
  primitive("subscribe", "subscribe", "subscribe", "reactive-materialization"),
]);

const NONDETERMINISTIC_WIT_TERMS = [
  "wall-clock",
  "current-time",
  "system-time",
  "date-now",
  "random",
  "rng",
];

export async function readRuntimeWit(path = WIT_PATH) {
  return readFile(path, "utf8");
}

export function assertRuntimeWitContract(source) {
  assertPackageVersion(source);
  assertNoNondeterministicWitContract(source);

  const parsed = parseRuntimeWit(source);
  for (const [interfaceName, expected] of Object.entries(EXPECTED_RUNTIME_INTERFACES)) {
    const actual = parsed.interfaces[interfaceName];
    if (!actual) {
      throw new Error(`runtime_primitives.missing_interface: ${interfaceName}`);
    }
    if (!sameList(actual.functions, expected.functions)) {
      throw new Error(
        `runtime_primitives.function_drift: ${interfaceName} expected ${expected.functions.join(",")}, got ${actual.functions.join(",")}`,
      );
    }
  }

  return {
    package: WIT_PACKAGE,
    version: WIT_VERSION,
    interfaces: Object.fromEntries(
      Object.keys(EXPECTED_RUNTIME_INTERFACES).map((name) => [name, parsed.interfaces[name]]),
    ),
  };
}

export function assertMatchesSdkPrimitiveTable(source, table = SDK_PRIMITIVE_TABLE) {
  assertPackageVersion(source);
  assertNoNondeterministicWitContract(source);
  const parsed = parseRuntimeWit(source);

  for (const entry of table) {
    const actual = parsed.interfaces[entry.interface];
    if (!actual?.functions.includes(entry.function)) {
      throw new Error(
        `runtime_primitives.signature_drift: ${entry.primitive} -> ${entry.interface}.${entry.function}`,
      );
    }
  }

  assertRuntimeWitContract(source);

  return {
    checked: table.length,
  };
}

export function assertNoNondeterministicWitContract(source) {
  const normalized = source.toLowerCase();
  const found = NONDETERMINISTIC_WIT_TERMS.find((term) => normalized.includes(term));
  if (found) {
    throw new Error(`runtime_primitives.nondeterministic_wit_shape: ${found}`);
  }
}

export function validateReplaySafety(table = SDK_PRIMITIVE_TABLE) {
  for (const entry of table) {
    if (entry.deterministic !== true || !entry.replayClass || NONDETERMINISTIC_WIT_TERMS.includes(entry.replayClass)) {
      throw new Error(`runtime_primitives.nondeterministic_primitive: ${entry.primitive}`);
    }
  }

  return {
    checked: table.length,
  };
}

export function buildManifestFragment(source) {
  assertRuntimeWitContract(source);

  return {
    schema: "hobo.manifest.fragment/runtime-primitives/v1",
    package: WIT_PACKAGE,
    version: WIT_VERSION,
    stability: STABILITY,
    world: "runtime-primitives",
    imports: Object.keys(EXPECTED_RUNTIME_INTERFACES).map((name) => ({
      interface: `${WIT_PACKAGE}/${name}@${WIT_VERSION}`,
      package: WIT_PACKAGE,
      name,
      version: WIT_VERSION,
      stability: STABILITY,
      replaySafe: true,
      source: "wit/world.wit",
    })),
  };
}

export function parseRuntimeWit(source) {
  const interfaces = {};
  const interfacePattern = /^interface\s+([a-z][a-z0-9-]*)\s+\{([\s\S]*?)^}/gm;
  let match;

  while ((match = interfacePattern.exec(source)) !== null) {
    const [, name, body] = match;
    if (name === "types") {
      continue;
    }

    interfaces[name] = {
      functions: parseFunctions(body),
    };
  }

  return { interfaces };
}

function parseFunctions(body) {
  const names = [];
  const functionPattern = /^\s*([a-z][a-z0-9-]*):\s+func\(/gm;
  let match;

  while ((match = functionPattern.exec(body)) !== null) {
    names.push(match[1]);
  }

  return names;
}

function assertPackageVersion(source) {
  const packageMatch = source.match(/^package\s+hobo:runtime@([0-9]+\.[0-9]+\.[0-9]+);/m);
  if (!packageMatch) {
    throw new Error("runtime_primitives.missing_package: hobo:runtime@0.1.0");
  }
  if (packageMatch[1] !== WIT_VERSION) {
    throw new Error(`runtime_primitives.version_drift: expected ${WIT_VERSION}, got ${packageMatch[1]}`);
  }
}

function iface(functions) {
  return Object.freeze({
    functions: Object.freeze(functions),
  });
}

function primitive(name, interfaceName, functionName, replayClass) {
  return Object.freeze({
    primitive: name,
    interface: interfaceName,
    function: functionName,
    replayClass,
    deterministic: true,
  });
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
