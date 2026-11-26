import { isJsonObject } from "./json.js";
import { stableDigest } from "../../control-plane-event-schema-contract/src/control-plane-events.js";

export const CONTRACT_VERSION = "sandboxed-executors-contract/v1";

/** @typedef {"firecracker" | "container"} SandboxBackendKind */
/** @typedef {"iac-pulumi" | "componentize"} ExecutorJobKind */
/** @typedef {"preview" | "apply" | "build"} ExecutorJobAction */

/**
 * @typedef {object} EgressTarget
 * @property {string} target
 * @property {"declared" | "undeclared"} declaration
 */

/**
 * @typedef {object} SandboxEgressAttempt
 * @property {string} target
 * @property {"normal" | "covert"} channel
 */

/**
 * @typedef {object} IacPulumiJob
 * @property {"iac-pulumi"} kind
 * @property {string} programId
 * @property {string} stackName
 * @property {"preview" | "apply"} action
 * @property {string[]} output
 * @property {JsonObject} [outputs]
 * @property {SandboxEgressAttempt[]} [egressAttempts]
 */

/**
 * @typedef {object} ComponentizeBuildJob
 * @property {"componentize"} kind
 * @property {string} serviceId
 * @property {"build"} action
 * @property {string[]} output
 * @property {JsonObject} [outputs]
 * @property {SandboxEgressAttempt[]} [egressAttempts]
 */

/** @typedef {IacPulumiJob | ComponentizeBuildJob} ExecutorJob */

/**
 * @typedef {object} DevModeCredentialStub
 * @property {string} id
 * @property {string} scope
 * @property {number} ttlSeconds
 * @property {boolean} devMode
 */

/**
 * @typedef {object} SandboxRunContext
 * @property {string} execId
 * @property {SandboxBackendKind} backend
 * @property {DevModeCredentialStub} credential
 * @property {boolean} ambientCredentials
 * @property {EgressTarget[]} allowedEgress
 */

export function createDevModeCredentialStub({ scope, ttlSeconds = 300 } = {}) {
  if (!scope) {
    throw new Error("credential scope is required");
  }

  return {
    id: `dev-stub-${stableDigest({ scope }).slice(0, 12)}`,
    scope,
    ttlSeconds,
    devMode: true
  };
}

export function selectSandboxBackend({ firecrackerAvailable }) {
  return firecrackerAvailable ? "firecracker" : "container";
}

export function createSandboxEgressGuard(allowedTargets) {
  const allowed = new Set(allowedTargets.map((entry) => entry.target));

  return {
    evaluate(attempt) {
      if (!allowed.has(attempt.target)) {
        return {
          outcome: "denied",
          reason: "sandbox.egress_scope",
          eventType: "sandbox.EgressDenied"
        };
      }

      if (attempt.channel === "covert") {
        return {
          outcome: "allowed-with-audit",
          reason: "sandbox.egress_scope",
          eventType: "sandbox.ScopedEgressObserved"
        };
      }

      return {
        outcome: "allowed",
        reason: "sandbox.egress_scope",
        eventType: "sandbox.ScopedEgressObserved"
      };
    }
  };
}

export function parseExecutorJob(raw) {
  if (!raw || !isJsonObject(raw)) {
    throw new Error("executor job must be an object");
  }

  const kind = raw.kind;
  if (kind === "iac-pulumi") {
    if (!raw.programId || !raw.stackName) {
      throw new Error("iac-pulumi job requires programId and stackName");
    }
    if (raw.action !== "preview" && raw.action !== "apply") {
      throw new Error("iac-pulumi action must be preview or apply");
    }

    return {
      kind,
      programId: String(raw.programId),
      stackName: String(raw.stackName),
      action: raw.action,
      output: Array.isArray(raw.output) ? raw.output.map(String) : [],
      outputs: raw.outputs ?? undefined,
      egressAttempts: parseEgressAttempts(raw.egressAttempts)
    };
  }

  if (kind === "componentize") {
    if (!raw.serviceId) {
      throw new Error("componentize job requires serviceId");
    }
    if (raw.action !== "build") {
      throw new Error("componentize action must be build");
    }

    return {
      kind,
      serviceId: String(raw.serviceId),
      action: "build",
      output: Array.isArray(raw.output) ? raw.output.map(String) : [],
      outputs: raw.outputs ?? undefined,
      egressAttempts: parseEgressAttempts(raw.egressAttempts)
    };
  }

  throw new Error(`unsupported executor job kind: ${String(kind)}`);
}

function parseEgressAttempts(raw) {
  if (raw === undefined) {
    return undefined;
  }

  if (!Array.isArray(raw)) {
    throw new Error("egressAttempts must be an array");
  }

  return raw.map((attempt) => {
    if (!attempt?.target) {
      throw new Error("egress attempt requires target");
    }

    const channel = attempt.channel === "covert" ? "covert" : "normal";
    return {
      target: String(attempt.target),
      channel
    };
  });
}

export function createSandboxedExecutor({
  firecrackerAvailable = true,
  allowedEgress = [],
  credentialBroker = createDefaultCredentialBroker()
} = {}) {
  const egressGuard = createSandboxEgressGuard(allowedEgress);

  return {
  async run(rawJob, options = {}) {
      const job = parseExecutorJob(rawJob);
      const execId = options.execId ?? `exec-${job.kind}-${stableDigest(job).slice(0, 8)}`;
      const correlationId = options.correlationId ?? `corr-${execId}`;
      const resourceId = job.kind === "iac-pulumi" ? job.programId : job.serviceId;
      const action = job.action;
      const scope =
        options.credentialScope ??
        `tenant:${options.tenant ?? "acme"}/resource:${resourceId}/job:${job.kind}/action:${action}`;

      const credential = credentialBroker.issue({ scope });
      const backend = selectSandboxBackend({ firecrackerAvailable });
      const events = [];
      const sandboxAudit = [];

      const context = {
        execId,
        backend,
        credential,
        ambientCredentials: false,
        allowedEgress
      };

      events.push(
        createExecEvent(
          "exec.Started",
          {
            execId,
            resourceId,
            programHash: hashRef(job)
          },
          { correlationId, seq: events.length + 1 }
        )
      );

      try {
        events.push(
          createExecEvent(
            "exec.Output",
            {
              execId,
              stream: "stdout",
              line: `sandbox=${backend} job=${job.kind} action=${action} ambientCredentials=false scope=${scope}`
            },
            { correlationId, seq: events.length + 1 }
          )
        );

        for (const attempt of job.egressAttempts ?? []) {
          const verdict = egressGuard.evaluate(attempt);
          sandboxAudit.push({
            target: attempt.target,
            channel: attempt.channel,
            outcome: verdict.outcome
          });

          if (verdict.outcome === "denied") {
            events.push(
              createExecEvent(
                "exec.Output",
                {
                  execId,
                  stream: "stderr",
                  line: `egress denied: ${attempt.target}`
                },
                { correlationId, seq: events.length + 1 }
              )
            );

            return finishFailed({
              execId,
              events,
              correlationId,
              classification: "fatal",
              reason: `undeclared egress denied: ${attempt.target}`,
              sandbox: context,
              sandboxAudit,
              credentialId: credential.id
            });
          }
        }

        for (const line of job.output ?? []) {
          events.push(
            createExecEvent(
              "exec.Output",
              {
                execId,
                stream: "stdout",
                line
              },
              { correlationId, seq: events.length + 1 }
            )
          );
        }

        events.push(
          createExecEvent(
            "exec.Succeeded",
            {
              execId,
              outputsHash: hashRef(job.outputs ?? { resourceId })
            },
            { correlationId, seq: events.length + 1 }
          )
        );

        return {
          status: "succeeded",
          execId,
          events,
          outputs: structuredClone(job.outputs ?? { resourceId }),
          sandbox: context,
          sandboxAudit,
          credentialId: credential.id
        };
      } finally {
        credentialBroker.revoke(credential);
      }
    }
  };
}

export function createFixtureIacPulumiJob(overrides = {}) {
  return {
    kind: "iac-pulumi",
    programId: overrides.programId ?? "shop-api",
    stackName: overrides.stackName ?? "shop-api",
    action: overrides.action ?? "apply",
    output: overrides.output ?? ["pulumi preview complete", "pulumi apply complete"],
    outputs: overrides.outputs ?? {
      endpoint: "https://shop-api.example",
      stackName: overrides.stackName ?? "shop-api"
    },
    egressAttempts: overrides.egressAttempts
  };
}

export function createFixtureComponentizeJob(overrides = {}) {
  return {
    kind: "componentize",
    serviceId: overrides.serviceId ?? "receipt-worker",
    action: "build",
    output: overrides.output ?? ["componentize build started", "wasm artifact produced"],
    outputs: overrides.outputs ?? {
      imageRef: "oci://registry.example/receipt-worker:sha256-abc",
      serviceId: overrides.serviceId ?? "receipt-worker"
    },
    egressAttempts: overrides.egressAttempts
  };
}

function createDefaultCredentialBroker() {
  const active = new Map();

  return {
    issue({ scope }) {
      const credential = createDevModeCredentialStub({ scope });
      active.set(credential.id, credential);
      return credential;
    },
    revoke(credential) {
      if (credential?.id) {
        active.delete(credential.id);
      }
    },
    activeCount() {
      return active.size;
    }
  };
}

function createExecEvent(type, data, { correlationId, seq }) {
  return {
    id: `evt-${stableDigest({ type, data, seq }).slice(0, 12)}`,
    type,
    schemaVersion: 1,
    tenant: "tenant-hobo",
    seq,
    time: "2026-07-01T00:00:00.000Z",
    actor: { kind: "service", id: "yard/executor" },
    correlationId,
    causationId: seq === 1 ? "cmd-dispatch-sandboxed-exec" : `evt-${seq - 1}`,
    data: structuredClone(data)
  };
}

function hashRef(value) {
  return `sha256:${stableDigest(value)}`;
}

function finishFailed({
  execId,
  events,
  correlationId,
  classification,
  reason,
  sandbox,
  sandboxAudit,
  credentialId
}) {
  const classifiedReason = `${classification}: ${reason}`;
  events.push(
    createExecEvent(
      "exec.Failed",
      {
        execId,
        reason: classifiedReason
      },
      { correlationId, seq: events.length + 1 }
    )
  );

  return {
    status: "failed",
    classification,
    reason: classifiedReason,
    execId,
    events,
    sandbox,
    sandboxAudit,
    credentialId
  };
}
