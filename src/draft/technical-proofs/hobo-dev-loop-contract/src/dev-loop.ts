import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  defineResource,
  resolveLocalCampResources,
} from "../../local-dev-test-authoring-contract/src/local-dev-test-authoring.js";
import {
  generateCodegenArtifacts,
  writeGeneratedTree,
} from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const STATE_SCHEMA = "hobo.dev-state/v1";
const DEFAULT_PORT = 4000;

export class HoboDevError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "HoboDevError";
    this.code = code;
    this.detail = detail;
  }
}

export function defineDevResource(kind, name, options = {}) {
  return defineResource(kind, name, options);
}

export function createHoboDevLoop(options = {}) {
  return new HoboDevLoop(options);
}

export function createForkLane({ service, into, shared }) {
  const baseline = cloneRecord(shared ?? {});
  const lane = cloneRecord(shared ?? {});
  const writes = new Map();

  return Object.freeze({
    service: requireNonEmptyString(service, "service"),
    into: requireNonEmptyString(into, "into"),
    read(key) {
      return lane[key];
    },
    write(key, value) {
      const stableKey = requireNonEmptyString(key, "key");
      lane[stableKey] = clone(value);
      writes.set(stableKey, clone(value));
    },
    diff() {
      const diff = {};
      for (const key of [...writes.keys()].sort()) {
        diff[key] = {
          baseline: clone(baseline[key]),
          lane: clone(lane[key]),
        };
      }
      return deepFreeze({ service, into, writes: diff });
    },
  });
}

class HoboDevLoop {
  constructor(options = {}) {
    this.bootMs = Number.isSafeInteger(options.bootMs) ? options.bootMs : 1_200;
    this.port = Number.isSafeInteger(options.port) ? options.port : DEFAULT_PORT;
    this.projectRoot = null;
    this.state = emptyState();
    this.alive = false;
    this.pendingSourceChanges = new Set();
    this.codegenRuns = 0;
  }

  async start({ projectRoot, resources = [], campOnlyCapabilities = [] } = {}) {
    this.projectRoot = resolve(requireNonEmptyString(projectRoot, "projectRoot"));
    this.state = await readDevState(this.projectRoot);
    const localPlan = resolveLocalCampResources(resources);
    this.alive = true;
    this.queueSourceChange("initial-start");

    return deepFreeze({
      command: "hobo dev",
      localUrl: `http://localhost:${this.port}`,
      cloudAccountRequired: false,
      bootedInMs: this.bootMs,
      runtime: "runtime-local",
      state: clone(this.state),
      localResources: localPlan.resources,
      fidelityLabels: fidelityLabels(localPlan.resources, campOnlyCapabilities),
    });
  }

  async handleRequest(request) {
    this.#assertStarted();
    const entry = {
      path: requireNonEmptyString(request?.path, "request.path"),
      body: clone(request.body ?? {}),
      handlerGeneration: this.state.handlerGeneration,
    };
    this.state = {
      ...this.state,
      runCount: this.state.runCount + 1,
      requests: [...this.state.requests, entry],
    };
    await writeDevState(this.projectRoot, this.state);

    return deepFreeze({
      status: 200,
      body: { ok: true, runCount: this.state.runCount },
      state: clone(this.state),
    });
  }

  async reloadHandler({ path, source }) {
    this.#assertStarted();
    try {
      assertValidModuleSource(source);
    } catch (error) {
      return deepFreeze({
        ok: false,
        code: "HOBO_DEV_RELOAD_ERROR",
        message: `${requireNonEmptyString(path, "path")}: ${error.message}`,
        daemonAlive: this.alive,
      });
    }

    this.state = {
      ...this.state,
      handlerGeneration: this.state.handlerGeneration + 1,
      lastReloaded: requireNonEmptyString(path, "path"),
    };
    await writeDevState(this.projectRoot, this.state);
    return deepFreeze({
      ok: true,
      code: "HOBO_DEV_RELOADED",
      handlerGeneration: this.state.handlerGeneration,
      daemonAlive: this.alive,
    });
  }

  queueSourceChange(path) {
    this.pendingSourceChanges.add(requireNonEmptyString(path, "path"));
  }

  async flushWatch() {
    this.#assertStarted();
    if (this.pendingSourceChanges.size === 0) {
      return deepFreeze({ codegenRuns: 0, changedSources: [] });
    }

    const changedSources = [...this.pendingSourceChanges].sort();
    this.pendingSourceChanges.clear();
    const artifacts = await generateCodegenArtifacts({ projectRoot: this.projectRoot });
    await writeGeneratedTree(this.projectRoot, artifacts);
    this.codegenRuns += 1;

    return deepFreeze({
      codegenRuns: 1,
      totalCodegenRuns: this.codegenRuns,
      changedSources,
      written: artifacts.map((artifact) => artifact.path),
    });
  }

  async replayPersistedState() {
    this.#assertStarted();
    return clone(await readDevState(this.projectRoot));
  }

  currentState() {
    return clone(this.state);
  }

  daemonAlive() {
    return this.alive;
  }

  async stop() {
    this.alive = false;
  }

  #assertStarted() {
    if (!this.alive || !this.projectRoot) {
      throw new HoboDevError("HOBO_DEV_NOT_RUNNING", "hobo dev loop is not running");
    }
  }
}

async function readDevState(projectRoot) {
  const path = statePath(projectRoot);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const state = emptyState();
      await writeDevState(projectRoot, state);
      return state;
    }
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (parsed.schema !== STATE_SCHEMA) {
    throw new HoboDevError(
      "HOBO_DEV_STATE_VERSION_UNSUPPORTED",
      `.hobo/dev-state.json schema ${parsed.schema ?? "missing"} is not supported`,
      { expected: STATE_SCHEMA, actual: parsed.schema },
    );
  }

  return {
    schema: STATE_SCHEMA,
    runCount: parsed.runCount ?? 0,
    handlerGeneration: parsed.handlerGeneration ?? 1,
    lastReloaded: parsed.lastReloaded ?? null,
    requests: Array.isArray(parsed.requests) ? parsed.requests.map(clone) : [],
  };
}

async function writeDevState(projectRoot, state) {
  const path = statePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(toStableValue(state), null, 2)}\n`);
}

function statePath(projectRoot) {
  return join(projectRoot, ".hobo", "dev-state.json");
}

function emptyState() {
  return {
    schema: STATE_SCHEMA,
    runCount: 0,
    handlerGeneration: 1,
    lastReloaded: null,
    requests: [],
  };
}

function fidelityLabels(resources, campOnlyCapabilities) {
  const labels = {};
  for (const resource of resources) {
    labels[resource.name] = fidelityClassFor(resource.kind);
  }
  for (const capability of campOnlyCapabilities) {
    labels[requireNonEmptyString(capability, "campOnlyCapabilities[]")] = "camp-only";
  }
  return labels;
}

function fidelityClassFor(kind) {
  if (["api", "service", "web", "websocket", "ui"].includes(kind)) return "real";
  if (["kv", "bucket", "queue", "topic", "data", "schedule", "flag", "experiment", "golden"].includes(kind)) {
    return "simulated";
  }
  if (["secret", "auth", "crypto", "notify", "guardrail"].includes(kind)) return "mocked";
  return "camp-only";
}

function assertValidModuleSource(source) {
  const text = requireNonEmptyString(source, "source");
  const stripped = text.replace(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=/g, "const $1 =");
  // Parse with the JS engine instead of string heuristics so ordinary syntax errors stay precise.
  new Function(stripped);
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function cloneRecord(value) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError("shared must be an object");
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return value;
}

function toStableValue(value) {
  if (Array.isArray(value)) return value.map(toStableValue);
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, toStableValue(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}
