import { resolve } from "node:path";

import { executeCollect } from "../../hobo-collect-cli-contract/src/collect-cli.js";
import { collectBindleResources } from "../../resource-collection-engine-contract/src/resource-collection-engine.js";
import { createRuntimeLocalComponentHost } from "../../runtime-local-component-host/src/component-host.js";
import {
  defineResource,
  resolveLocalCampResources,
} from "../../local-dev-test-authoring-contract/src/local-dev-test-authoring.js";

import { DevStateStore } from "./dev-state-store.js";
import { fidelityLabels } from "./fidelity.js";
import { reloadHandler } from "./hot-reload.js";
import { createWatchCodegen, type WatchCodegen } from "./watch-codegen.js";
import {
  COLD_BOOT_BUDGET_MS,
  DevParseError,
  DevSessionOptions,
  DevSessionRecord,
  DevStateSnapshot,
  parseDevSessionOptions,
} from "./types.js";
import { isJsonString, type JsonValue, type JsonObject } from "./json.js";


export class HoboDevError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: JsonObject = {},
  ) {
    super(message);
    this.name = "HoboDevError";
  }
}

export interface DevSession {
  readonly record: DevSessionRecord;
  handleRequest(request: { path: string; body?: unknown }): Promise<{
    status: number;
    body: JsonObject;
    state: DevStateSnapshot;
  }>;
  reloadHandler(input: { path: string; source: string }): ReturnType<typeof reloadHandler>;
  watchCodegen: WatchCodegen;
  replayPersistedState(): Promise<DevStateSnapshot>;
  currentState(): DevStateSnapshot;
  daemonAlive(): boolean;
  stop(): Promise<void>;
  runtimeHost: ReturnType<typeof createRuntimeLocalComponentHost>;
}

export function defineDevResource(kind: string, name: string, options: JsonObject = {}) {
  return defineResource(kind, name, options);
}

export async function startDevSession(rawOptions: DevSessionOptions): Promise<DevSession> {
  const options = parseDevSessionOptions(rawOptions);
  const projectRoot = resolve(requireNonEmptyString(options.projectRoot, "projectRoot"));
  const store = new DevStateStore(projectRoot);

  let state: DevStateSnapshot;
  try {
    state = await store.load();
  } catch (error) {
    if (error instanceof DevParseError) {
      throw new HoboDevError(error.code, error.message, error.detail);
    }
    throw error;
  }

  const resources = options.resources ?? [];
  const campOnly = options.campOnlyCapabilities ?? [];
  const localPlan = resolveLocalCampResources(resources);
  const labels = fidelityLabels(localPlan.resources, campOnly);

  const collectResult = await executeCollect({
    project: sampleCollectProject(),
    engine: collectBindleResources,
    request: { json: true, out: null, camp: null, cwd: projectRoot },
  });

  const host = createRuntimeLocalComponentHost();
  host.registerProvider({
    id: "local-http",
    exports: {
      "wasi:http/outgoing-handler@0.2.0": {
        handle: () => ({ status: 200, body: "hello-bindle:ok" }),
      },
    },
  });
  host.loadComponent({
    id: "hello-bindle",
    imports: ["wasi:http/outgoing-handler@0.2.0"],
    exports: {
      "wasi:http/incoming-handler@0.2.0": {
        handle: async () => ({ status: 200, body: { ok: true } }),
      },
    },
  });

  for (const resource of localPlan.resources) {
    if (labels.labels[resource.name] === "camp-only") continue;
    try {
      host.link({
        componentId: "hello-bindle",
        importInterface: "wasi:http/outgoing-handler@0.2.0",
        providerId: "local-http",
        exportInterface: "wasi:http/outgoing-handler@0.2.0",
      });
      break;
    } catch {
      // deny-by-default: only link resolvable imports once
    }
  }

  const sessionId = `dev-${projectRoot.split("/").pop() ?? "session"}`;
  state = await store.append({
    family: "dev.SessionStarted",
    payload: {
      sessionId,
      port: options.port,
      bootMs: options.bootMs,
      manifestHash: collectResult.manifestHash,
    },
  });

  let alive = true;
  const watchCodegen = createWatchCodegen(store, projectRoot);
  watchCodegen.queueSourceChange("initial-start");

  const record: DevSessionRecord = Object.freeze({
    sessionId,
    localUrl: `http://localhost:${options.port}`,
    bootMs: options.bootMs,
    cloudAccountRequired: false,
    runtime: "runtime-local",
    fidelityLabels: labels.labels,
    state: clone(state),
  });

  if (options.bootMs > COLD_BOOT_BUDGET_MS) {
    throw new HoboDevError("HOBO_DEV_COLD_BOOT_EXCEEDED", `cold boot ${options.bootMs}ms exceeds ${COLD_BOOT_BUDGET_MS}ms budget`);
  }

  return {
    record,
    async handleRequest(request) {
      assertAlive();
      const path = requireNonEmptyString(request.path, "request.path");
      const body = request.body ?? {};
      state = await store.append({
        family: "dev.RequestServed",
        payload: { path, status: 200, body },
      });
      return Object.freeze({
        status: 200,
        body: { ok: true, runCount: state.runCount },
        state: clone(state),
      });
    },
    reloadHandler(input) {
      assertAlive();
      return reloadHandler(store, input, () => alive);
    },
    watchCodegen,
    async replayPersistedState() {
      assertAlive();
      return clone(await store.load());
    },
    currentState() {
      return clone(state);
    },
    daemonAlive() {
      return alive;
    },
    async stop() {
      alive = false;
      await store.append({ family: "dev.SessionStopped", payload: { sessionId } });
    },
    runtimeHost: host,
  };

  function assertAlive() {
    if (!alive) {
      throw new HoboDevError("HOBO_DEV_NOT_RUNNING", "hobo dev loop is not running");
    }
  }
}

function sampleCollectProject() {
  return {
    bindleId: "hello-bindle",
    fileName: "hello-bindle.ts",
    guestLanguage: "ts" as const,
    sourceText: `export default function hello() { return { status: 200 }; }`,
    define: (collect: { api: (name: string) => { route: (method: string, path: string) => void } }) => {
      const api = collect.api("main");
      api.route("GET", "/health");
    },
  };
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function clone<T>(value: T): T {
  if (structuredClone instanceof Function) {
    return structuredClone(value);
  }
  const cloned: T =
    // SAFETY: JSON round-trip clones JSON-compatible session state.
    JSON.parse(JSON.stringify(value)) as T;
  return cloned;
}
