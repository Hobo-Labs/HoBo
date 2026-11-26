import { isJsonString, isJsonObject } from "./json.js";
export function fixtureEvents() {
  return [
    runEvent(1, "run.Started", { runId: "run-1" }),
    runEvent(2, "run.StepCompleted", { runId: "run-1", name: "plan", attempts: 1, durationMs: 12 }),
    runEvent(3, "run.StepCompleted", { runId: "run-1", name: "apply", attempts: 1, durationMs: 21 }),
    runEvent(4, "run.Completed", { runId: "run-1" }),
    deployEvent(5, "deployment.Started", { deploymentId: "deploy-1" }),
    deployEvent(6, "deployment.ResourceState", { deploymentId: "deploy-1", resourceId: "api", state: "provisioning" }),
    deployEvent(7, "deployment.ResourceState", { deploymentId: "deploy-1", resourceId: "api", state: "provisioned" }),
    deployEvent(8, "deployment.ResourceState", { deploymentId: "deploy-1", resourceId: "db", state: "provisioned" }),
    topologyEvent(9, "topology.ResourceResolved", {
      id: "api",
      kind: "service",
      provider: "aws",
      region: "us-east-1",
    }),
    topologyEvent(10, "topology.ResourceResolved", {
      id: "db",
      kind: "postgres",
      provider: "neon",
      region: "us-east-1",
    }),
    topologyEvent(11, "topology.BindEdge", {
      from: "api",
      to: "db",
      capability: "postgres",
      tier: "private-link",
    }),
    runEvent(11, "run.Started", { runId: "run-2" }),
    runEvent(11, "run.StepCompleted", { runId: "run-2", name: "plan", attempts: 1, durationMs: 11 }),
    runEvent(11, "run.StepStarted", { runId: "run-2", name: "apply", attempts: 1 }),
  ];
}

export function createInspectStore(seedEvents = []) {
  const events = normalizeEvents(seedEvents);

  return Object.freeze({
    headSeq: events.at(-1)?.seq ?? 0,
    inspect(subject, options = {}) {
      const at = normalizeAt(options.at, this.headSeq);
      const scoped = events.filter((event) => event.seq <= at);
      const view = materialize(subject, scoped, options.selector);

      return Object.freeze({
        subject,
        selector: view.id ?? subject,
        at,
        seq: Object.freeze({ head: at }),
        view: deepFreeze(view),
      });
    },
  });
}

export function createInspectCli({ store }) {
  return Object.freeze({
    async run(argv, runOptions = {}) {
      try {
        const request = parseInspectArgv(argv);
        const source = request.remote ? "remote" : (runOptions.source ?? "local");
        if (source === "remote" && !runOptions.identity?.svid) {
          throw new InspectError('Remote inspect needs a valid SVID. Run "hobo login" and retry.', 1);
        }

        const inspection = store.inspect(request.subject, {
          selector: request.selector,
          at: request.at,
        });
        const envelope = {
          ok: true,
          verb: "inspect",
          subject: inspection.subject,
          selector: inspection.selector,
          source,
          at: inspection.at,
          seq: inspection.seq,
          view: inspection.view,
        };

        return {
          exitCode: 0,
          stdout: request.json ? `${JSON.stringify(envelope)}\n` : renderHuman(envelope),
          stderr: "",
        };
      } catch (error) {
        return renderError(error);
      }
    },
  });
}

class InspectError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function materialize(subject, events, selector) {
  switch (subject) {
    case "run":
      return selectRun(materializeRuns(events), selector);
    case "deploy":
      return selectById(materializeDeployments(events), selector, "deploy");
    case "topology":
      return materializeTopology(events);
    default:
      throw new InspectError(`Unknown inspect subject "${subject}".`, 2);
  }
}

function materializeRuns(events) {
  const runs = new Map();

  for (const event of events) {
    if (!event.type.startsWith("run.")) {
      continue;
    }
    const runId = event.data.runId;
    const run = ensureRun(runs, runId, event.seq);
    run.lastSeq = event.seq;

    if (event.type === "run.Completed") {
      run.status = "completed";
      run.partial = false;
      continue;
    }

    if (event.type === "run.StepStarted") {
      upsertStep(run, {
        name: event.data.name,
        status: "running",
        attempts: event.data.attempts,
        durationMs: null,
      });
    }

    if (event.type === "run.StepCompleted") {
      upsertStep(run, {
        name: event.data.name,
        status: "completed",
        attempts: event.data.attempts,
        durationMs: event.data.durationMs,
      });
    }
  }

  return [...runs.values()].sort((left, right) => left.id.localeCompare(right.id)).map((run) => ({
    id: run.id,
    status: run.status,
    partial: run.partial,
    steps: run.steps,
    actors: [],
    sagas: [],
    lastSeq: run.lastSeq,
  }));
}

function materializeDeployments(events) {
  const deployments = new Map();

  for (const event of events) {
    if (!event.type.startsWith("deployment.")) {
      continue;
    }
    const deploymentId = event.data.deploymentId;
    const deployment = ensureDeployment(deployments, deploymentId, event.seq);
    deployment.lastSeq = event.seq;

    if (event.type === "deployment.ResourceState") {
      deployment.resources.set(event.data.resourceId, {
        id: event.data.resourceId,
        state: event.data.state,
      });
    }
  }

  return [...deployments.values()].sort((left, right) => left.id.localeCompare(right.id)).map((deployment) => ({
    id: deployment.id,
    status: deploymentStatus(deployment),
    resources: [...deployment.resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    rollback: [],
    compensation: [],
    lastSeq: deployment.lastSeq,
  }));
}

function materializeTopology(events) {
  const resources = new Map();
  const bindEdges = [];

  for (const event of events) {
    if (event.type === "topology.ResourceResolved") {
      resources.set(event.data.id, {
        id: event.data.id,
        kind: event.data.kind,
        provider: event.data.provider,
        region: event.data.region,
      });
    }

    if (event.type === "topology.BindEdge") {
      bindEdges.push({
        from: event.data.from,
        to: event.data.to,
        capability: event.data.capability,
        tier: event.data.tier,
      });
    }
  }

  return {
    id: "topology",
    resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    bindEdges: bindEdges.sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)),
  };
}

function selectRun(runs, selector) {
  const selected = selector
    ? runs.find((run) => run.id === selector)
    : runs.reduce((latest, run) => (run.lastSeq > latest.lastSeq ? run : latest), runs[0]);
  if (!selected) {
    const name = selector ?? "--last";
    throw new InspectError(`Unknown run "${name}". No RunView projection row exists.`);
  }
  return selected;
}

function selectById(rows, selector, label) {
  const selected = rows.find((row) => row.id === selector);
  if (!selected) {
    throw new InspectError(`Unknown ${label} "${selector}". No ${label} projection row exists.`);
  }
  return selected;
}

function ensureRun(runs, id, seq) {
  if (!runs.has(id)) {
    runs.set(id, {
      id,
      status: "in_flight",
      partial: true,
      steps: [],
      lastSeq: seq,
    });
  }
  return runs.get(id);
}

function ensureDeployment(deployments, id, seq) {
  if (!deployments.has(id)) {
    deployments.set(id, {
      id,
      resources: new Map(),
      lastSeq: seq,
    });
  }
  return deployments.get(id);
}

function upsertStep(run, nextStep) {
  const index = run.steps.findIndex((step) => step.name === nextStep.name);
  const normalized = {
    name: nextStep.name,
    status: nextStep.status,
    attempts: nextStep.attempts,
    durationMs: nextStep.durationMs,
  };
  if (index === -1) {
    run.steps.push(normalized);
    return;
  }
  run.steps[index] = normalized;
}

function deploymentStatus(deployment) {
  return [...deployment.resources.values()].every((resource) => resource.state === "provisioned")
    ? "ready"
    : "in_progress";
}

function parseInspectArgv(argv) {
  const flags = {
    at: null,
    json: false,
    remote: false,
    selector: null,
    last: false,
  };
  const [subject, ...tokens] = argv;
  if (!subject) {
    throw new InspectError("inspect requires run, deploy, or topology.", 2);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--remote") {
      flags.remote = true;
      continue;
    }
    if (token === "--last") {
      flags.last = true;
      continue;
    }
    if (token === "--at") {
      const value = tokens[index + 1];
      if (!value) {
        throw new InspectError("--at requires a seq value.", 2);
      }
      flags.at = Number(value);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new InspectError(`Unknown inspect option "${token}".`, 2);
    }
    flags.selector = token;
  }

  return {
    subject,
    selector: flags.last ? null : flags.selector,
    at: flags.at,
    json: flags.json,
    remote: flags.remote,
  };
}

function normalizeAt(at, headSeq) {
  if (at == null) {
    return headSeq;
  }
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new InspectError("--at must be a non-negative integer seq.", 2);
  }
  if (at > headSeq) {
    throw new InspectError(`Cannot inspect --at ${at} beyond log head ${headSeq}.`, 2);
  }
  return at;
}

function normalizeEvents(seedEvents) {
  return seedEvents
    .map((event, index) => ({
      ...event,
      seq: assertSeq(event.seq),
      type: assertNonEmpty(event.type, "event.type"),
      data: event.data ,
      index,
    }))
    .sort((left, right) => left.seq - right.seq || left.index - right.index);
}

function renderHuman(envelope) {
  if (envelope.subject === "run") {
    const status = envelope.view.partial ? "PARTIAL" : envelope.view.status.toUpperCase();
    const steps = envelope.view.steps
      .map((step) => {
        const duration = step.durationMs == null ? "" : ` duration=${step.durationMs}ms`;
        return `step ${step.name} ${step.status} attempts=${step.attempts}${duration}`;
      })
      .join("\n");
    return `Run ${envelope.view.id} ${status} @seq ${envelope.seq.head}\n${steps}\n`;
  }

  if (envelope.subject === "deploy") {
    const resources = envelope.view.resources.map((resource) => `${resource.id} ${resource.state}`).join("\n");
    return `Deploy ${envelope.view.id} ${envelope.view.status} @seq ${envelope.seq.head}\n${resources}\n`;
  }

  const resources = envelope.view.resources.map((resource) => `${resource.id} ${resource.provider}/${resource.region}`).join("\n");
  return `Topology @seq ${envelope.seq.head}\n${resources}\n`;
}

function renderError(error) {
  if (error instanceof InspectError) {
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: `${error.message}\n`,
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: "Internal inspect error.\n",
  };
}

function runEvent(seq, type, data) {
  return { seq, type, streamId: `run:${data.runId}`, data };
}

function deployEvent(seq, type, data) {
  return { seq, type, streamId: `deploy:${data.deploymentId}`, data };
}

function topologyEvent(seq, type, data) {
  return { seq, type, streamId: "topology", data };
}

function assertSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("event.seq must be a non-negative safe integer");
  }
  return value;
}

function assertNonEmpty(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
