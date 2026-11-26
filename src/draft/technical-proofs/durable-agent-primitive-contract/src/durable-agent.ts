import assert from "node:assert/strict";

import { createIdentityEvent } from "../../identity-event-contract/src/identity-event-contract.js";
import {
  createTokenBroker,
  createTokenContext,
} from "../../token-broker-skeleton-contract/src/token-broker-skeleton.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_NOW = () => new Date("2026-06-25T10:00:00.000Z");

export class AgentReplayDivergenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgentReplayDivergenceError";
    this.details = details;
  }
}

export function agent(name, definition) {
  return defineAgent(name, definition);
}

export function defineAgent(name, definition) {
  const agentName = requireNonEmptyString(name, "agent.name");
  if (!definition || !isJsonObject(definition) || Array.isArray(definition)) {
    throw new TypeError("agent definition must be an object");
  }
  if (!(definition.run instanceof Function)) {
    throw new TypeError("agent.run must be a function");
  }

  const tools = normalizeTools(definition.tools ?? {});

  return Object.freeze({
    kind: "agent",
    name: agentName,
    model: definition.model ?? "fixture-model",
    instructions: definition.instructions ?? "",
    tools,
    run: definition.run,
  });
}

export function createAgentRuntime(options = {}) {
  const runs = new Map();
  const eventLog = [];
  const now = options.now ?? DEFAULT_NOW;
  const idFactory = options.idFactory ?? defaultIdFactory();
  const broker =
    options.broker ??
    createTokenBroker({
      registry: options.registry,
      now,
      idFactory,
      eventSink: (event) => eventLog.push(event),
    });
  const tokenContextFactory =
    options.tokenContextFactory ??
    ((subject, svidScope) => createTokenContext(broker, { subject, svidScope }));

  let nextRunSeq = 1;

  return Object.freeze({
    getEventLog() {
      return clone(eventLog);
    },

    async run(agentDef, input, runOptions = {}) {
      assertAgent(agentDef);
      const runId = runOptions.runId ?? `agent-run-${nextRunSeq++}`;
      const subject = normalizePrincipal(
        runOptions.subject ?? {
          kind: "agent",
          id: `agent:${agentDef.name}`,
          delegatedBy: runOptions.delegatedBy,
        },
        "subject",
      );
      const svidScope = normalizeSvidScope(
        runOptions.svidScope ?? [{ port: "database", resource: "shop.db", actions: ["read", "write"] }],
      );
      const identity = issueIdentity({ subject, svidScope, now, idFactory, eventLog });

      const run = {
        runId,
        agent: agentDef,
        input: clone(input),
        subject,
        svidScope,
        identity,
        state: { output: undefined, toolResults: [] },
        steps: [],
        tokenSteps: [],
        events: [],
        mode: "live",
      };
      runs.set(runId, run);

      const ctx = createAgentContext({
        run,
        broker,
        tokenContextFactory,
        eventLog,
        recordSteps: true,
      });

      run.events.push(
        agentEvent("agent.run.started", runId, {
          agent: agentDef.name,
          model: agentDef.model,
          identityId: identity.identityId,
        }),
      );

      const output = await agentDef.run(ctx, clone(input));
      run.state.output = clone(output);
      run.events.push(agentEvent("agent.run.completed", runId, { output: clone(output) }));

      return publicRun(run);
    },

    async replay(runRef) {
      const liveRun = getRun(runs, runRef);
      const replayed = await replayAgentRun(liveRun, {
        broker,
        tokenContextFactory,
        eventLog,
      });

      try {
        assert.deepEqual(replayed.state, liveRun.state);
      } catch {
        throw new AgentReplayDivergenceError("agent replay diverged from live state", {
          runId: liveRun.runId,
          live: clone(liveRun.state),
          replay: clone(replayed.state),
        });
      }

      return {
        runId: liveRun.runId,
        replayEqualsLive: true,
        state: clone(replayed.state),
      };
    },

    getRun(runRef) {
      return publicRun(getRun(runs, runRef));
    },
  });
}

export async function replayAgentRun(liveRun, deps) {
  const replayRun = {
    ...liveRun,
    mode: "replay",
    state: { output: undefined, toolResults: [] },
    steps: [],
    events: liveRun.events.filter((event) => event.type.startsWith("agent.")),
  };

  const ctx = createAgentContext({
    run: replayRun,
    broker: deps.broker,
    tokenContextFactory: deps.tokenContextFactory,
    eventLog: deps.eventLog,
    recordSteps: false,
    stepSource: liveRun.steps,
    tokenStepSource: liveRun.tokenSteps,
  });

  const output = await liveRun.agent.run(ctx, clone(liveRun.input));
  replayRun.state.output = clone(output);
  return replayRun;
}

function createAgentContext({
  run,
  broker: _broker,
  tokenContextFactory,
  eventLog: _eventLog,
  recordSteps,
  stepSource = [],
  tokenStepSource = [],
}) {
  const tokenCtx = tokenContextFactory(run.subject, run.svidScope);
  let stepIndex = 0;
  let tokenStepIndex = 0;

  return Object.freeze({
  identity: Object.freeze({
    identityId: run.identity.identityId,
    svidRef: run.identity.svidRef,
    subject: clone(run.subject),
    scope: clone(run.identity.scope),
    expiresAt: run.identity.expiresAt,
  }),

  async token(provider, scope, overrides = {}) {
    if (run.mode === "replay") {
      const cached = tokenStepSource[tokenStepIndex++];
      if (!cached || cached.provider !== provider) {
        throw new AgentReplayDivergenceError("replay token step mismatch", {
          expectedProvider: provider,
          cachedProvider: cached?.provider,
          tokenStepIndex,
        });
      }
      return clone(cached.result);
    }

    const result = await tokenCtx.token(provider, scope, overrides);
    if (Array.isArray(result.events)) {
      for (const event of result.events) {
        run.events.push(event);
      }
    }

    if (recordSteps) {
      run.tokenSteps.push({
        provider,
        scope: clone(scope),
        result: clone(result),
      });
    }

    return result;
  },

  async tool(toolName, args = {}) {
    const tool = run.agent.tools[toolName];
    if (!tool) {
      throw new Error(`unknown agent tool: ${toolName}`);
    }

    if (run.mode === "replay") {
      const cached = stepSource[stepIndex++];
      if (!cached || cached.tool !== toolName) {
        throw new AgentReplayDivergenceError("replay step mismatch", {
          expectedTool: toolName,
          cachedTool: cached?.tool,
          stepIndex,
        });
      }
      run.state.toolResults.push(clone(cached.result));
      return clone(cached.result);
    }

    const stepId = `${run.runId}:step:${run.steps.length + 1}`;
    const requested = agentEvent("agent.tool.step.requested", run.runId, {
      stepId,
      tool: toolName,
      args: clone(args),
    });
    run.events.push(requested);

    const result = await tool.invoke(args, this);
    const completed = agentEvent("agent.tool.step.completed", run.runId, {
      stepId,
      tool: toolName,
      result: clone(result),
    });
    run.events.push(completed);

    if (recordSteps) {
      run.steps.push({
        stepId,
        tool: toolName,
        args: clone(args),
        result: clone(result),
      });
    }

    run.state.toolResults.push(clone(result));
    return result;
  },
  });
}

function issueIdentity({ subject, svidScope, now, idFactory, eventLog }) {
  const identityId = idFactory("svid");
  const issued = createIdentityEvent(
    "identity.Issued",
    {
      identityId,
      subject,
      svidRef: `identity://svid/${identityId}`,
      scope: clone(svidScope),
      expiresAt: new Date(now().getTime() + 10 * 60 * 1000).toISOString(),
    },
    {
      id: `evt-${identityId}-issued`,
      actor: subject,
      time: now().toISOString(),
      seq: 1,
    },
  );
  eventLog.push(issued);

  return {
    identityId,
    svidRef: issued.data.svidRef,
    scope: clone(svidScope),
    expiresAt: issued.data.expiresAt,
    event: issued,
  };
}

function normalizeTools(tools) {
  if (!tools || !isJsonObject(tools) || Array.isArray(tools)) {
    throw new TypeError("agent.tools must be an object");
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        if (!tool || !(tool.invoke instanceof Function)) {
          throw new TypeError(`tool ${name} must expose invoke(args, ctx)`);
        }
        return [
          name,
          Object.freeze({
            name,
            description: tool.description ?? "",
            invoke: tool.invoke,
          }),
        ];
      }),
    ),
  );
}

function agentEvent(type, runId, data) {
  return Object.freeze({
    id: `${runId}:${type}:${Object.keys(data).join("-")}`,
    type,
    runId,
    time: DEFAULT_NOW().toISOString(),
    data: clone(data),
  });
}

function publicRun(run) {
  return Object.freeze({
    runId: run.runId,
    agent: run.agent.name,
    input: clone(run.input),
    output: clone(run.state.output),
    identity: clone(run.identity),
    steps: clone(run.steps),
    events: clone(run.events),
    toolResults: clone(run.state.toolResults),
  });
}

function getRun(runs, runRef) {
  const runId = isJsonString(runRef) ? runRef : runRef?.runId;
  const run = runs.get(runId);
  if (!run) {
    throw new Error(`unknown agent run: ${runId}`);
  }
  return run;
}

function assertAgent(agentDef) {
  if (!agentDef || agentDef.kind !== "agent") {
    throw new TypeError("expected an agent definition from agent() or defineAgent()");
  }
}

function normalizePrincipal(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be a PrincipalRef`);
  }
  const normalized = {
    kind: requireNonEmptyString(value.kind, `${field}.kind`),
    id: requireNonEmptyString(value.id, `${field}.id`),
  };
  if (value.delegatedBy !== undefined) {
    normalized.delegatedBy = normalizePrincipal(value.delegatedBy, `${field}.delegatedBy`);
  }
  return normalized;
}

function normalizeSvidScope(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("svidScope must be a non-empty array");
  }
  return value.map((entry, index) => {
    if (!entry || !isJsonObject(entry) || Array.isArray(entry)) {
      throw new Error(`svidScope[${index}] must be an object`);
    }
    return {
      port: requireNonEmptyString(entry.port, `svidScope[${index}].port`),
      resource: requireNonEmptyString(entry.resource, `svidScope[${index}].resource`),
      actions: entry.actions.map((action, actionIndex) =>
        requireNonEmptyString(action, `svidScope[${index}].actions[${actionIndex}]`),
      ),
    };
  });
}

function requireNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function clone(value) {
  if (structuredClone instanceof Function) {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
