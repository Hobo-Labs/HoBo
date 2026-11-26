import { CANONICAL_VERBS } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import {
  createInspectCli,
  createInspectStore,
  fixtureEvents,
} from "../../hobo-inspect-projection-contract/src/inspect-contract.js";
import { MCP_TOOL_SPECS } from "../../hobo-mcp-server-contract/src/mcp-server-contract.js";
import {
  createSamplePlanFixture,
  runHoboPlan,
} from "../../hobo-plan-preview-contract/src/plan-preview.js";
import { createRunInspectorProjection } from "../../run-inspector-projection-contract/src/run-inspector.js";
import { isJsonString, isJsonObject } from "./json.js";


export const EXTENSION_SURFACE_VERSION = "hobo.extension-surface/v1";

export const EXTENSION_COMMAND_BINDINGS = Object.freeze([
  Object.freeze({
    command: "hobo.vscode.openTopology",
    cliVerb: "inspect",
    cliArgs: ["topology", "--json"],
    mcpTool: "get_bindle",
  }),
  Object.freeze({
    command: "hobo.vscode.openRunInspector",
    cliVerb: "inspect",
    mcpTool: "inspect_run",
  }),
  Object.freeze({
    command: "hobo.vscode.explainThisPlan",
    cliVerb: "plan",
    mcpTool: "plan",
  }),
]);

const DEFAULT_VIEWPORT_SIZE = 100;
const DEFAULT_SVID_STORE_REF = "hobo-cli://svid-store/current";
const DEFAULT_PROVIDER_TYPES = Object.freeze({
  aws: Object.freeze({
    source: "@hobo/aws/provider-options.d.ts",
    options: Object.freeze([
      Object.freeze({ label: "s3", capability: "object-storage" }),
      Object.freeze({ label: "dynamoDb", capability: "key-value" }),
      Object.freeze({ label: "containerApp", capability: "http-service" }),
    ]),
  }),
});

export function createVsCodeExtensionAdapter(options = {}) {
  const embeddedCredentials = findEmbeddedCredentials(options.extensionManifest ?? {});
  if (embeddedCredentials.length > 0) {
    throw new Error(`VS Code extension manifest contains embedded credential material: ${embeddedCredentials.join(", ")}`);
  }

  const events = options.events ?? fixtureEvents();
  const store = options.inspectStore ?? createInspectStore(events);
  const inspectCli = options.inspectCli ?? createInspectCli({ store });
  const runInspector = options.runInspector ?? createRunInspectorProjection(events);
  const planFixture = options.planFixture ?? createSamplePlanFixture();
  const planRunner = options.planRunner ?? runHoboPlan;
  const viewportSize = normalizeViewportSize(options.viewportSize ?? DEFAULT_VIEWPORT_SIZE);
  const providerTypes = options.providerTypes ?? DEFAULT_PROVIDER_TYPES;
  const devReachable = options.devReachable ?? true;
  const campReachable = options.campReachable ?? true;
  const extensionSurfaceVersion = options.extensionSurfaceVersion ?? EXTENSION_SURFACE_VERSION;
  const cliSurfaceVersion = options.cliSurfaceVersion ?? EXTENSION_SURFACE_VERSION;

  function surfaceWarning() {
    if (extensionSurfaceVersion === cliSurfaceVersion) {
      return null;
    }
    return {
      code: "HOBO_EXTENSION_SURFACE_MISMATCH",
      message: `VS Code extension surface ${extensionSurfaceVersion} is behind CLI surface ${cliSurfaceVersion}.`,
      action: "Upgrade the HoBo VS Code extension or align the hobo CLI version.",
    };
  }

  function needsDevPrompt() {
    return {
      status: "needs-dev",
      prompt: {
        message: "Start hobo dev to connect the VS Code extension to local projections.",
        action: {
          label: "Start dev",
          command: "hobo.dev",
          args: ["dev"],
        },
      },
    };
  }

  return Object.freeze({
    async openWorkspace() {
      const warning = surfaceWarning();
      if (warning) {
        return {
          status: "surface-warning",
          topology: null,
          warnings: [warning],
        };
      }

      if (!devReachable || !campReachable) {
        return {
          ...needsDevPrompt(),
          topology: null,
          warnings: [],
        };
      }

      const result = await inspectCli.run(["topology", "--json"], {
        source: "local",
        identity: credentialUse(),
      });
      if (result.exitCode !== 0) {
        return {
          ...needsDevPrompt(),
          topology: null,
          warnings: [{ code: "HOBO_TOPOLOGY_UNAVAILABLE", message: result.stderr.trim() }],
        };
      }

      const envelope = JSON.parse(result.stdout);
      return {
        status: "ready",
        topology: topologyWindow(envelope.view, viewportSize),
        handlerTrace: {
          topology: bindingTrace("hobo.vscode.openTopology"),
        },
        warnings: [],
      };
    },

    async selectRun(runId, options = {}) {
      const warning = surfaceWarning();
      if (warning) {
        return {
          status: "surface-warning",
          run: null,
          warnings: [warning],
        };
      }

      if (!devReachable || !campReachable) {
        return {
          ...needsDevPrompt(),
          run: null,
          warnings: [],
        };
      }

      const view = runInspector.inspectRun(runId, {
        atSeq: options.atSeq,
        pageSize: options.pageSize ?? Number.MAX_SAFE_INTEGER,
      });
      return {
        status: "ready",
        run: {
          sourceProjection: "RunView",
          id: view.id,
          status: view.status,
          partial: view.partial,
          atSeq: view.atSeq,
          steps: view.steps.items,
          timeline: view.timeline,
          actors: view.actors,
          sagas: view.sagas,
          causality: view.causality,
        },
        handlerTrace: bindingTrace("hobo.vscode.openRunInspector", ["run", runId, "--json"]),
        warnings: [],
      };
    },

    async explainThisPlan({ camp }) {
      const warning = surfaceWarning();
      if (warning) {
        return {
          status: "surface-warning",
          plan: null,
          inlineAnnotations: [],
          warnings: [warning],
        };
      }

      if (!devReachable || !campReachable) {
        return {
          ...needsDevPrompt(),
          plan: null,
          inlineAnnotations: [],
          warnings: [],
        };
      }

      const argv = ["--camp", camp, "--json"];
      const result = planRunner(argv, planFixture);
      return {
        status: result.exitCode === 2 ? "plan-error" : "ready",
        plan: result.preview,
        inlineAnnotations: planAnnotations(result.preview),
        handlerTrace: bindingTrace("hobo.vscode.explainThisPlan", argv),
        warnings: result.preview.warnings ?? [],
      };
    },

    completeProviderOptions({ sourceText, cursor }) {
      const textBeforeCursor = sourceText.slice(0, cursor);
      const match = textBeforeCursor.match(/\.with\(([\w$]+)\.$/);
      if (!match) {
        return {
          status: "no-match",
          source: null,
          items: [],
        };
      }

      const providerName = match[1];
      const provider = providerTypes[providerName];
      if (!provider) {
        return {
          status: "no-provider-types",
          source: null,
          items: [],
        };
      }

      return {
        status: "ready",
        source: provider.source,
        items: provider.options.map((option) => ({
          label: option.label,
          detail: `${providerName}.${option.label}: ${option.capability} options`,
          insertText: option.label,
        })),
      };
    },

    credentialUse,
  });
}

export function assertSharedExtensionHandlers(options = {}) {
  const bindings = options.bindings ?? EXTENSION_COMMAND_BINDINGS;
  const cliVerbs = new Set((options.cliVerbs ?? CANONICAL_VERBS).map((verb) => (isJsonString(verb) ? verb : verb.name)));
  const mcpTools = new Set((options.mcpTools ?? MCP_TOOL_SPECS).map((tool) => tool.name));
  const missing = [];

  for (const binding of bindings) {
    if (!cliVerbs.has(binding.cliVerb)) {
      missing.push({ command: binding.command, missing: `cli:${binding.cliVerb}` });
    }
    if (!mcpTools.has(binding.mcpTool)) {
      missing.push({ command: binding.command, missing: `mcp:${binding.mcpTool}` });
    }
  }

  return {
    ok: missing.length === 0,
    commands: bindings.map((binding) => binding.command),
    missing,
  };
}

export function sampleRunEvents() {
  return [
    event(1, "run.Started", { runId: "run-264" }, { causationId: "cmd-1" }),
    event(2, "run.StepStarted", {
      runId: "run-264",
      stepId: "plan",
      attempts: 1,
      input: { manifest: "bindle-a" },
      signature: "plan(input:v1)",
    }),
    event(3, "run.StepCompleted", {
      runId: "run-264",
      stepId: "plan",
      attempts: 1,
      durationMs: 12,
      output: { planId: "plan-a" },
      memoizedResult: { planId: "plan-a" },
      signature: "plan(input:v1)",
    }),
    event(4, "actor.Activated", { actorId: "resource:api", runId: "run-264" }),
    event(5, "saga.Started", { sagaId: "deploy-saga", runId: "run-264" }),
    event(6, "run.StepStarted", {
      runId: "run-264",
      stepId: "apply",
      attempts: 1,
      input: { planId: "plan-a" },
      signature: "apply(input:v1)",
    }),
    event(7, "run.StepRetried", { runId: "run-264", stepId: "apply", attempt: 2 }),
    event(8, "run.StepCompleted", {
      runId: "run-264",
      stepId: "apply",
      attempts: 2,
      durationMs: 55,
      output: { resourceId: "api-1" },
      memoizedResult: { resourceId: "api-1" },
      signature: "apply(input:v1)",
    }),
    event(9, "saga.Completed", { sagaId: "deploy-saga", runId: "run-264" }),
    event(10, "actor.Passivated", { actorId: "resource:api", runId: "run-264" }),
    event(11, "run.Completed", { runId: "run-264" }),
  ];
}

export function largeTopologyEvents(count) {
  const total = normalizePositiveInteger(count, "count");
  const events = [];

  for (let index = 0; index < total; index += 1) {
    events.push({
      seq: index + 1,
      type: "topology.ResourceResolved",
      streamId: "topology",
      data: {
        id: `service-${String(index).padStart(4, "0")}`,
        kind: "service",
        provider: index % 2 === 0 ? "aws" : "azure",
        region: index % 2 === 0 ? "us-east-1" : "westus2",
      },
    });
  }

  for (let index = 1; index < total; index += 1) {
    events.push({
      seq: total + index,
      type: "topology.BindEdge",
      streamId: "topology",
      data: {
        from: `service-${String(index).padStart(4, "0")}`,
        to: `service-${String(index - 1).padStart(4, "0")}`,
        capability: "http",
        tier: index % 5 === 0 ? "public-mtls" : "private-link",
      },
    });
  }

  return events;
}

function topologyWindow(view, viewportSize) {
  const resources = [...(view.resources ?? [])];
  const bindEdges = [...(view.bindEdges ?? [])];
  const edgeWindow = Math.min(bindEdges.length, Math.max(0, viewportSize - 1));

  return {
    sourceProjection: "TopologyView",
    virtualized: resources.length > viewportSize || bindEdges.length > edgeWindow,
    nodeCount: resources.length,
    edgeCount: bindEdges.length,
    visibleNodes: resources.slice(0, viewportSize),
    visibleEdges: bindEdges.slice(0, edgeWindow),
  };
}

function planAnnotations(preview) {
  const resourceAnnotations = (preview.resources ?? []).map((resource) => ({
    kind: "resource-resolution",
    severity: "info",
    target: resource.id,
    message: `${resource.id} -> ${resource.provider} (${resource.reason}; est $${Number(resource.estimatedMonthlyUsd).toFixed(2)}/mo)`,
  }));
  const warningAnnotations = (preview.warnings ?? []).map((warning) => ({
    kind: "warning",
    severity: "warning",
    target: warning.resourceId ?? "plan",
    message: warning.message,
  }));

  return [...resourceAnnotations, ...warningAnnotations];
}

function bindingTrace(command, overrideArgs) {
  const binding = EXTENSION_COMMAND_BINDINGS.find((candidate) => candidate.command === command);
  if (!binding) {
    throw new Error(`Unknown VS Code command binding ${command}`);
  }

  return {
    command: binding.command,
    cliVerb: binding.cliVerb,
    cliArgs: overrideArgs ?? binding.cliArgs,
    mcpTool: binding.mcpTool,
  };
}

function credentialUse() {
  return {
    mode: "cli-svid-store-ref",
    svidStoreRef: DEFAULT_SVID_STORE_REF,
    embeddedCredentials: [],
  };
}

function findEmbeddedCredentials(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findEmbeddedCredentials(entry, [...path, String(index)]));
  }
  if (!value || !isJsonObject(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = [...path, key];
    if (isJsonString(child) && isCredentialKey(key) && !isCredentialReference(child)) {
      return [childPath.join(".")];
    }
    return findEmbeddedCredentials(child, childPath);
  });
}

function isCredentialKey(key) {
  return /^(accessKey|secret|secretKey|token|privateKey|password|credential)$/i.test(key);
}

function isCredentialReference(value) {
  return /^(hobo-cli:\/\/|env:|file:|svid:)/.test(value);
}

function normalizeViewportSize(value) {
  return normalizePositiveInteger(value, "viewportSize");
}

function normalizePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function event(seq, type, data, options = {}) {
  return {
    id: `evt-${seq}`,
    seq,
    type,
    ts: `2026-06-26T09:${String(seq).padStart(2, "0")}:00.000Z`,
    correlationId: data.runId,
    causationId: options.causationId ?? (seq === 1 ? undefined : `evt-${seq - 1}`),
    data,
  };
}
