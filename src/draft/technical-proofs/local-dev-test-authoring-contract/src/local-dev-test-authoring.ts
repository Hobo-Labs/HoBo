import assert from "node:assert/strict";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_START_INSTANT = "2026-06-26T00:00:00.000Z";

const DEFAULT_LOCAL_EQUIVALENTS = Object.freeze({
  api: Object.freeze({ driver: "local-http-router", fidelity: "in-process" }),
  kv: Object.freeze({ driver: "memory-kv", fidelity: "in-memory" }),
  cache: Object.freeze({ driver: "memory-cache", fidelity: "in-memory" }),
  bucket: Object.freeze({ driver: "filesystem-blobstore", fidelity: "filesystem" }),
  queue: Object.freeze({ driver: "memory-queue", fidelity: "in-memory" }),
  topic: Object.freeze({ driver: "memory-pubsub", fidelity: "in-memory" }),
  secret: Object.freeze({ driver: "dev-secret-store", fidelity: "dev-only" }),
  data: Object.freeze({ driver: "sqlite-data", fidelity: "local-database" }),
  schedule: Object.freeze({ driver: "deterministic-clock", fidelity: "deterministic" }),
  websocket: Object.freeze({ driver: "in-process-websocket", fidelity: "in-process" }),
  job: Object.freeze({ driver: "inline-job-runner", fidelity: "in-process" }),
  web: Object.freeze({ driver: "static-file-server", fidelity: "filesystem" }),
  service: Object.freeze({ driver: "wasm-component-local", fidelity: "in-process" }),
  flag: Object.freeze({ driver: "memory-flag-store", fidelity: "in-memory" }),
  auth: Object.freeze({ driver: "contract-dev-principal", fidelity: "fixture" }),
  crypto: Object.freeze({ driver: "local-kms-simulator", fidelity: "fixture" }),
  notify: Object.freeze({ driver: "capture-notify-sink", fidelity: "fixture" }),
  guardrail: Object.freeze({ driver: "stub-guardrail", fidelity: "fixture" }),
  ui: Object.freeze({ driver: "local-ui-renderer", fidelity: "in-process" }),
  golden: Object.freeze({ driver: "file-golden-suite", fidelity: "filesystem" }),
  experiment: Object.freeze({ driver: "deterministic-experiment", fidelity: "deterministic" }),
});

export class ReplayDivergenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReplayDivergenceError";
    this.details = details;
  }
}

export class LocalResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalResolutionError";
  }
}

export class DevSecretResolutionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DevSecretResolutionError";
    this.skippedInteractivePrompt = options.skippedInteractivePrompt === true;
  }
}

export function defineWorkflow(name, definition) {
  const workflowName = requireNonEmptyString(name, "workflow.name");
  if (!definition || !isJsonObject(definition) || Array.isArray(definition)) {
    throw new TypeError("workflow definition must be an object");
  }
  if (!(definition.initialState instanceof Function)) {
    throw new TypeError("workflow.initialState must be a function");
  }

  return Object.freeze({
    kind: "workflow",
    name: workflowName,
    initialState: definition.initialState,
    onStart: optionalHandler(definition.onStart, "workflow.onStart"),
    onHook: optionalHandler(definition.onHook, "workflow.onHook"),
    onTimer: optionalHandler(definition.onTimer, "workflow.onTimer"),
  });
}

export function testRuntime(options = {}) {
  const runs = new Map();
  const runtime = {
    seed: requireNonEmptyString(options.seed ?? "runtime-local-test-seed", "options.seed"),
    nowMs: parseInstantMs(options.startInstant ?? DEFAULT_START_INSTANT, "options.startInstant"),
    nextRunSeq: 1,
    nextTimerSeq: 1,
  };

  return Object.freeze({
    clock: Object.freeze({
      now() {
        return formatInstant(runtime.nowMs);
      },
      advance(duration) {
        const deltaMs = parseDurationMs(duration, "duration");
        runtime.nowMs += deltaMs;
        const fired = [];

        for (;;) {
          const due = nextDueTimer(runs, runtime.nowMs);
          if (!due) {
            break;
          }
          due.timer.firedAtMs = due.timer.fireAtMs;
          due.run.trace.push({
            type: "timer.fired",
            timerId: due.timer.timerId,
            label: due.timer.label,
            atMs: due.timer.fireAtMs,
            fireAtMs: due.timer.fireAtMs,
          });
          fired.push(publicTimer(due.timer));
          if (due.run.workflow.onTimer) {
            applyHandler(due.run, due.run.workflow.onTimer, publicTimer(due.timer));
          }
        }

        return Object.freeze(fired);
      },
    }),

    async start(workflow, args) {
      assertWorkflow(workflow);
      const run = {
        runId: `run-${runtime.nextRunSeq++}`,
        workflow,
        args: clone(args),
        state: clone(workflow.initialState(clone(args))),
        trace: [],
        emittedEvents: [],
        timers: [],
        waitingHooks: [],
      };
      runs.set(run.runId, run);
      run.trace.push({
        type: "workflow.started",
        workflow: workflow.name,
        args: clone(args),
        atMs: runtime.nowMs,
      });
      if (workflow.onStart) {
        applyHandler(run, workflow.onStart, clone(args));
      }
      return publicRun(run);
    },

    async resumeHook(runRef, payload) {
      const run = getRun(runs, runRef);
      run.trace.push({
        type: "hook.resumed",
        payload: clone(payload),
        atMs: runtime.nowMs,
      });
      if (run.workflow.onHook) {
        applyHandler(run, run.workflow.onHook, clone(payload));
      }
      return publicRun(run);
    },

    async state(runRef) {
      return clone(getRun(runs, runRef).state);
    },

    async replay(runRef) {
      const run = getRun(runs, runRef);
      const replay = replayRun(run, runtime);
      try {
        assert.deepEqual(replay.state, run.state);
        assert.deepEqual(replay.emittedEvents, run.emittedEvents);
      } catch {
        throw new ReplayDivergenceError("replay diverged from live state", {
          runId: run.runId,
          live: clone(run.state),
          replay: clone(replay.state),
        });
      }
      return clone(replay.state);
    },

    async assertEmittedEvents(runRef) {
      return clone(getRun(runs, runRef).emittedEvents);
    },
  });

  function applyHandler(run, handler, input) {
    const ctx = createContext({
      run,
      runtime,
      record: true,
    });
    const nextState = handler(ctx, clone(run.state), input);
    if (nextState !== undefined) {
      run.state = clone(nextState);
    }
  }
}

export function defineResource(kind, name, options = {}) {
  const resourceKind = requireNonEmptyString(kind, "resource.kind");
  const resourceName = requireNonEmptyString(name, "resource.name");
  return Object.freeze({
    kind: resourceKind,
    name: resourceName,
    stableId: `${resourceKind}:${resourceName}`,
    portRef: options.portRef,
  });
}

export function resolveLocalCampResources(resources, options = {}) {
  if (!Array.isArray(resources)) {
    throw new TypeError("resources must be an array");
  }
  const equivalents = options.equivalents ?? DEFAULT_LOCAL_EQUIVALENTS;

  return deepFreeze({
    camp: "local",
    resources: resources.map((resource) => {
      const normalized = normalizeResource(resource);
      const equivalent = equivalents[normalized.kind];
      if (!equivalent) {
        throw new LocalResolutionError(`no local equivalent for ${normalized.kind} ${normalized.name}`);
      }
      return {
        name: normalized.name,
        kind: normalized.kind,
        stableId: normalized.stableId,
        source: "local-equivalent",
        driver: equivalent.driver,
        fidelity: equivalent.fidelity,
        requiresProviderSymbol: false,
        providerSymbol: null,
      };
    }),
  });
}

export function defineDevSecret(ref, options = {}) {
  const secretRef = requireNonEmptyString(ref, "secret.ref");
  return Object.freeze({
    kind: "dev-secret-ref",
    ref: secretRef,
    required: options.required !== false,
    stableId: `secret-ref:${secretRef}`,
  });
}

export function resolveDevSecretSource(secret, options = {}) {
  const ref = normalizeDevSecret(secret).ref;
  if (hasOwn(options.envLocal, ref)) {
    return devSecretResolution(ref, ".env.local");
  }
  if (hasOwn(options.keychain, ref)) {
    return devSecretResolution(ref, "os-keychain");
  }
  if (options.ci === true) {
    throw new DevSecretResolutionError(
      `interactive dev secret prompt skipped in CI for ${ref}`,
      { skippedInteractivePrompt: true },
    );
  }
  if (options.prompt instanceof Function) {
    options.prompt(ref);
    return devSecretResolution(ref, "interactive-prompt");
  }

  throw new DevSecretResolutionError(`no dev secret source available for ${ref}`);
}

function replayRun(run, runtime) {
  const startEntry = run.trace.find((entry) => entry.type === "workflow.started");
  const replayTimerSchedule = {
    entries: run.trace.filter((entry) => entry.type === "timer.scheduled"),
    index: 0,
  };
  const replay = {
    runId: run.runId,
    workflow: run.workflow,
    args: clone(run.args),
    state: clone(run.workflow.initialState(clone(run.args))),
    trace: [],
    emittedEvents: [],
    timers: [],
    waitingHooks: [],
  };

  if (run.workflow.onStart) {
    applyReplayHandler(replay, runtime, run.workflow.onStart, clone(run.args), {
      nowMs: startEntry?.atMs,
      replayTimerSchedule,
    });
  }

  for (const entry of run.trace) {
    if (entry.type === "hook.resumed" && run.workflow.onHook) {
      applyReplayHandler(replay, runtime, run.workflow.onHook, clone(entry.payload), {
        nowMs: entry.atMs,
        replayTimerSchedule,
      });
    } else if (entry.type === "timer.fired" && run.workflow.onTimer) {
      applyReplayHandler(replay, runtime, run.workflow.onTimer, publicTimer(entry), {
        nowMs: entry.atMs,
        replayTimerSchedule,
      });
    }
  }

  if (replayTimerSchedule.index !== replayTimerSchedule.entries.length) {
    throw new ReplayDivergenceError("replay did not schedule every recorded timer", {
      runId: run.runId,
      recordedTimers: replayTimerSchedule.entries.length,
      replayedTimers: replayTimerSchedule.index,
    });
  }

  return replay;
}

function applyReplayHandler(run, runtime, handler, input, options = {}) {
  const ctx = createContext({
    run,
    runtime,
    record: false,
    nowMs: options.nowMs,
    replayTimerSchedule: options.replayTimerSchedule,
  });
  const nextState = handler(ctx, clone(run.state), input);
  if (nextState !== undefined) {
    run.state = clone(nextState);
  }
}

function createContext({ run, runtime, record, nowMs, replayTimerSchedule }) {
  const handlerNowMs = nowMs ?? runtime.nowMs;
  return Object.freeze({
    seed: runtime.seed,
    now() {
      return formatInstant(handlerNowMs);
    },
    emit(type, data = {}) {
      const event = {
        type: requireNonEmptyString(type, "event.type"),
        data: clone(data),
      };
      run.emittedEvents.push(event);
      if (record) {
        run.trace.push({ type: "event.emitted", event: clone(event), atMs: runtime.nowMs });
      }
      return Object.freeze(clone(event));
    },
    waitForHook(name = "default") {
      const hook = {
        name: requireNonEmptyString(name, "hook.name"),
        waitingAt: formatInstant(handlerNowMs),
      };
      run.waitingHooks.push(hook);
      if (record) {
        run.trace.push({ type: "hook.waiting", hook: clone(hook), atMs: runtime.nowMs });
      }
      return Object.freeze(clone(hook));
    },
    sleep(duration, options = {}) {
      const delayMs = parseDurationMs(duration, "duration");
      if (!record) {
        return replayTimer(duration, options, replayTimerSchedule, run.runId);
      }

      const timer = {
        timerId: requireNonEmptyString(options.id ?? `timer-${runtime.nextTimerSeq++}`, "timer.id"),
        label: options.label === undefined ? undefined : requireNonEmptyString(options.label, "timer.label"),
        delayMs,
        scheduledAtMs: handlerNowMs,
        fireAtMs: handlerNowMs + delayMs,
        firedAtMs: null,
      };
      run.timers.push(timer);
      if (record) {
        run.trace.push({
          type: "timer.scheduled",
          timerId: timer.timerId,
          label: timer.label,
          delayMs: timer.delayMs,
          scheduledAtMs: timer.scheduledAtMs,
          fireAtMs: timer.fireAtMs,
        });
      }
      return Object.freeze(publicTimer(timer));
    },
  });
}

function replayTimer(duration, options, replayTimerSchedule, runId) {
  const recorded = replayTimerSchedule?.entries[replayTimerSchedule.index++];
  if (!recorded) {
    throw new ReplayDivergenceError("replay scheduled an unrecorded timer", { runId });
  }

  const expectedDelayMs = parseDurationMs(duration, "duration");
  const expectedId = options.id === undefined ? undefined : requireNonEmptyString(options.id, "timer.id");
  const expectedLabel = options.label === undefined ? undefined : requireNonEmptyString(options.label, "timer.label");
  if (
    recorded.delayMs !== expectedDelayMs ||
    (expectedId !== undefined && recorded.timerId !== expectedId) ||
    (expectedLabel !== undefined && recorded.label !== expectedLabel)
  ) {
    throw new ReplayDivergenceError("replay timer schedule diverged", {
      runId,
      recorded: clone(recorded),
      replayed: {
        timerId: expectedId,
        label: expectedLabel,
        delayMs: expectedDelayMs,
      },
    });
  }

  return Object.freeze(publicTimer(recorded));
}

function nextDueTimer(runs, nowMs) {
  const candidates = [];
  for (const run of runs.values()) {
    for (const timer of run.timers) {
      if (timer.firedAtMs === null && timer.fireAtMs <= nowMs) {
        candidates.push({ run, timer });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.timer.fireAtMs - right.timer.fireAtMs ||
      left.run.runId.localeCompare(right.run.runId) ||
      left.timer.timerId.localeCompare(right.timer.timerId),
  );
  return candidates[0];
}

function publicRun(run) {
  return Object.freeze({
    runId: run.runId,
    workflow: run.workflow.name,
  });
}

function publicTimer(timer) {
  return Object.freeze({
    timerId: timer.timerId,
    label: timer.label,
    fireAt: timer.fireAtMs === undefined ? formatInstant(timer.atMs) : formatInstant(timer.fireAtMs),
  });
}

function getRun(runs, runRef) {
  const runId = isJsonString(runRef) ? runRef : runRef?.runId;
  const run = runs.get(runId);
  if (!run) {
    throw new TypeError(`unknown run ${runId}`);
  }
  return run;
}

function assertWorkflow(workflow) {
  if (workflow?.kind !== "workflow" || !isJsonString(workflow.name)) {
    throw new TypeError("workflow must be created by defineWorkflow");
  }
}

function optionalHandler(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (!(value instanceof Function)) {
    throw new TypeError(`${fieldName} must be a function`);
  }
  return value;
}

function normalizeResource(resource) {
  if (!resource || !isJsonObject(resource)) {
    throw new TypeError("resource must be an object");
  }
  return defineResource(resource.kind, resource.name, { portRef: resource.portRef });
}

function normalizeDevSecret(secret) {
  if (secret?.kind !== "dev-secret-ref") {
    throw new TypeError("secret must be created by defineDevSecret");
  }
  return secret;
}

function devSecretResolution(ref, sourceKind) {
  return deepFreeze({
    ref,
    camp: "local",
    source: "dev",
    sourceKind,
    production: false,
    canSatisfyProductionDeploy: false,
    valueAvailable: true,
    auditEvent: {
      type: "secret.Accessed",
      camp: "local",
      source: "dev",
      ref,
    },
  });
}

function hasOwn(source, key) {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function parseDurationMs(value, fieldName) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (!isJsonString(value)) {
    throw new TypeError(`${fieldName} must be a duration string or non-negative integer`);
  }
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    throw new TypeError(`${fieldName} must use ms, s, m, or h`);
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  return amount * multiplier;
}

function parseInstantMs(value, fieldName) {
  const ms = Date.parse(value);
  if (!isJsonString(value) || Number.isNaN(ms)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return ms;
}

function formatInstant(ms) {
  return new Date(ms).toISOString();
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return value;
}
