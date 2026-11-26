import { stableDigest } from "../../control-plane-event-schema-contract/src/control-plane-events.js";

export function createFixtureIacProgram(overrides = {}) {
  return {
    kind: "iac-program",
    id: overrides.id ?? "iac-assets-apply",
    provider: overrides.provider ?? "local",
    resourceId: overrides.resourceId ?? "assets",
    action: overrides.action ?? "apply",
    output: overrides.output ?? ["preview complete", "apply complete"],
    failure: overrides.failure ? structuredClone(overrides.failure) : undefined,
    waitFor: overrides.waitFor,
    crashAfterStarted: overrides.crashAfterStarted ?? false,
    outputs: overrides.outputs ?? {
      endpoint: "memory://assets",
      resourceId: "assets"
    }
  };
}

export function createStubTokenBroker({ expireAfterOutputCount = Number.POSITIVE_INFINITY } = {}) {
  const activeTokens = new Map();
  const auditLog = [];

  return {
    auditLog,
    issue({ scope, resourceId, action }) {
      const token = {
        id: `token-${stableDigest({ scope, resourceId, action }).slice(0, 12)}`,
        scope,
        resourceId,
        action,
        outputCount: 0,
        expired: false,
        issued: true
      };
      activeTokens.set(token.id, token);
      auditLog.push({ type: "issued", tokenId: token.id, scope });
      return token;
    },
    observeOutput(token) {
      const active = activeTokens.get(token?.id);
      if (!active) return false;

      active.outputCount += 1;
      if (!active.expired && active.outputCount >= expireAfterOutputCount) {
        active.expired = true;
        auditLog.push({ type: "expired", tokenId: active.id, reason: "mid-run-expiry" });
      }

      return !active.expired;
    },
    revoke(token, reason = "executor-finished") {
      if (token?.id && activeTokens.delete(token.id)) {
        auditLog.push({ type: "revoked", tokenId: token.id, reason });
      }
    },
    activeTokenCount() {
      return activeTokens.size;
    }
  };
}

export function createFlakyOutputTransport({ failAfterLines }) {
  let written = 0;

  return {
    write(line) {
      if (written >= failAfterLines) {
        throw new Error(`output stream severed after ${written} lines`);
      }
      written += 1;
      return line;
    }
  };
}

export function createRecordingRelayTransport({ targetId }) {
  const auditLog = [];

  return {
    auditLog,
    routeWork({ execId, resourceId, provider }) {
      auditLog.push({
        type: "work-routed",
        targetId,
        execId,
        resourceId,
        provider
      });
    },
    routeResult({ execId, status }) {
      auditLog.push({
        type: "result-routed",
        targetId,
        execId,
        status
      });
    }
  };
}

export function createInProcessExecutor({
  tokenBroker,
  concurrencyLimit = 1,
  outputTransport = { write: (line) => line },
  relayTransport = { routeWork() {}, routeResult() {} }
} = {}) {
  if (!tokenBroker) {
    throw new Error("tokenBroker is required");
  }
  let activeRuns = 0;

  return {
    async dispatch(program, options) {
      if (activeRuns >= concurrencyLimit) {
        throw new Error("executor concurrency limit exceeded");
      }

      activeRuns += 1;
      const execId = options.execId ?? `exec-${program.resourceId}-${program.action}`;
      const correlationId = options.correlationId ?? `corr-${execId}`;
      const token = tokenBroker.issue({
        scope: options.credentialScope,
        resourceId: options.resourceId,
        action: options.action
      });
      const events = [];
      relayTransport.routeWork({
        execId,
        resourceId: options.resourceId,
        provider: program.provider
      });

      const finishFailed = (failure) => {
        const result = failedRun(failure);
        relayTransport.routeResult({ execId, status: result.status });
        return result;
      };

      try {
        events.push(createExecEvent("exec.Started", {
          execId,
          resourceId: options.resourceId,
          programHash: hashRef(program)
        }, { correlationId, seq: events.length + 1 }));

        if (program.crashAfterStarted) {
          return finishFailed({
            execId,
            events,
            correlationId,
            tokenId: token.id,
            classification: "fatal",
            reason: "executor crash before completion"
          });
        }

        for (const line of program.output ?? []) {
          try {
            outputTransport.write(line);
          } catch {
            return finishFailed({
              execId,
              events,
              correlationId,
              tokenId: token.id,
              classification: "ambiguous",
              reason: "output stream severed mid-apply; reconcile required",
              reconcileRequired: true
            });
          }

          events.push(createExecEvent("exec.Output", {
            execId,
            stream: "stdout",
            line
          }, { correlationId, seq: events.length + 1 }));

          if (!tokenBroker.observeOutput(token)) {
            return finishFailed({
              execId,
              events,
              correlationId,
              tokenId: token.id,
              classification: "retryable",
              reason: "token expired mid-run"
            });
          }
        }

        if (program.waitFor) {
          await program.waitFor;
        }

        if (program.failure) {
          return finishFailed({
            execId,
            events,
            correlationId,
            tokenId: token.id,
            classification: program.failure.classification ?? "fatal",
            reason: program.failure.reason
          });
        }

        events.push(createExecEvent("exec.Succeeded", {
          execId,
          outputsHash: hashRef(program.outputs)
        }, { correlationId, seq: events.length + 1 }));
        relayTransport.routeResult({ execId, status: "succeeded" });

        return {
          status: "succeeded",
          execId,
          events,
          outputs: structuredClone(program.outputs),
          tokenId: token.id
        };
      } finally {
        tokenBroker.revoke(token);
        activeRuns -= 1;
      }
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
    time: "2026-06-25T00:00:00.000Z",
    actor: { kind: "service", id: "yard/executor" },
    correlationId,
    causationId: seq === 1 ? "cmd-dispatch-iac-program" : `evt-${seq - 1}`,
    data: structuredClone(data)
  };
}

function hashRef(value) {
  return `sha256:${stableDigest(value)}`;
}

function failedRun({
  execId,
  events,
  correlationId,
  tokenId,
  classification,
  reason,
  reconcileRequired = false
}) {
  const classifiedReason = `${classification}: ${reason}`;
  events.push(createExecEvent("exec.Failed", {
    execId,
    reason: classifiedReason
  }, { correlationId, seq: events.length + 1 }));

  return {
    status: "failed",
    classification,
    reason: classifiedReason,
    reconcileRequired,
    execId,
    events,
    tokenId
  };
}
