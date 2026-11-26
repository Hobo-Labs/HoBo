export function evaluateCanDeploy({
  target,
  camp = {},
  proposedSet = {},
  eventLog = [],
} = {}) {
  const enforcementMode = camp.enforcementMode ?? "strict";
  const runningFacts = eventLog.filter(
    (event) => event?.type === "deployment.Running" && event.target === target,
  );
  const matrix = [];
  const failures = [];

  if (runningFacts.length === 0) {
    failures.push({
      reason: "unknown-running-versions",
      target,
    });
  }

  for (const producer of proposedSet.producers ?? []) {
    for (const running of runningFacts) {
      for (const consumer of running.consumes ?? []) {
        if (consumer.producer !== producer.component || consumer.channel !== producer.channel) {
          continue;
        }

        const missingFields = difference(consumer.requiredFields, producer.provides);
        const row = {
          channel: producer.channel,
          producer: componentVersion(producer),
          proposedContractVersion: producer.contractVersion,
          consumer: componentVersion(running),
          runningContractVersion: consumer.contractVersion,
          requiredFields: sortedUnique(consumer.requiredFields),
          providedFields: sortedUnique(producer.provides),
          compatible: missingFields.length === 0,
        };
        matrix.push(row);

        if (missingFields.length > 0) {
          failures.push({
            reason: "producer-broke-consumer",
            channel: producer.channel,
            producer: row.producer,
            proposedContractVersion: producer.contractVersion,
            consumer: row.consumer,
            runningContractVersion: consumer.contractVersion,
            missingFields,
          });
        }
      }
    }
  }

  for (const consumer of proposedSet.consumers ?? []) {
    for (const running of runningFacts) {
      if (running.component !== consumer.producer) {
        continue;
      }

      for (const producer of running.produces ?? []) {
        if (producer.channel !== consumer.channel) {
          continue;
        }

        const missingFields = difference(consumer.requires, producer.providedFields);
        const row = {
          channel: consumer.channel,
          producer: componentVersion(running),
          runningContractVersion: producer.contractVersion,
          consumer: componentVersion(consumer),
          proposedContractVersion: consumer.contractVersion,
          requiredFields: sortedUnique(consumer.requires),
          providedFields: sortedUnique(producer.providedFields),
          compatible: missingFields.length === 0,
        };
        matrix.push(row);

        if (missingFields.length > 0) {
          failures.push({
            reason: "consumer-over-specified",
            channel: consumer.channel,
            producer: row.producer,
            runningContractVersion: producer.contractVersion,
            consumer: row.consumer,
            proposedContractVersion: consumer.contractVersion,
            missingFields,
          });
        }
      }
    }
  }

  return buildDecision({ target, enforcementMode, matrix, failures });
}

export function runCanDeployCommand(args = [], fixtures = {}) {
  const target = parseTarget(args);
  if (!target) {
    throw new Error("missing required --target");
  }

  const decision = evaluateCanDeploy({
    target,
    camp: fixtures.camps?.[target] ?? fixtures.camp ?? {},
    proposedSet: fixtures.proposedSet ?? {},
    eventLog: fixtures.eventLog ?? [],
  });

  return {
    command: "hobo can-deploy",
    target,
    exitCode: decision.ok ? 0 : 1,
    decision,
  };
}

export function replayCompatibilityDecision(events = []) {
  const event = events.at(-1);
  if (!event || !event.type?.startsWith("compat.Gate")) {
    throw new Error("no compat.Gate event to replay");
  }

  return {
    ok: event.type === "compat.GatePassed",
    target: event.target,
    enforcementMode: event.enforcementMode,
    matrix: event.matrix,
    failures: event.failures,
    suggestedFixes: event.suggestedFixes,
    summary: event.summary,
    events,
  };
}

function buildDecision({ target, enforcementMode, matrix, failures }) {
  const ok = failures.length === 0;
  const suggestedFixes = ok ? [] : buildSuggestedFixes(failures[0]);
  const summary = ok ? "compatible" : buildFailureSummary(target, failures[0]);
  const event = {
    type: ok ? "compat.GatePassed" : "compat.GateFailed",
    target,
    enforcementMode,
    matrix,
    failures,
    suggestedFixes,
    summary,
  };

  return {
    ok,
    target,
    enforcementMode,
    matrix,
    failures,
    suggestedFixes,
    summary,
    events: [event],
  };
}

function buildFailureSummary(target, failure) {
  if (failure.reason === "unknown-running-versions") {
    return `blocked: unknown running versions for ${target}; compatibility cannot assume an empty event log is safe.`;
  }
  if (failure.reason === "consumer-over-specified") {
    return `blocked: ${failure.consumer} requires ${failure.missingFields.join(", ")}, but ${failure.producer} (running in ${target}) publishes ${failure.runningContractVersion} without those fields.`;
  }

  return `blocked: ${failure.producer} publishes ${failure.channel} ${failure.proposedContractVersion}, but ${failure.consumer} (running in ${target}) consumes ${failure.runningContractVersion} which requires ${failure.missingFields.join(", ")}.`;
}

function buildSuggestedFixes(failure) {
  if (failure.reason === "unknown-running-versions") {
    return ["rebuild the target running-version snapshot from deployment.Running events"];
  }
  if (failure.reason === "consumer-over-specified") {
    return [
      `deploy ${nextMinor(failure.producer)} first`,
      `loosen ${failure.consumer} to tolerate missing ${failure.missingFields.join(", ")}`,
      "add a compatibility shim",
    ];
  }

  return [
    `dual-publish ${failure.missingFields.join(", ")} during a migration window`,
    `deploy ${nextMinor(failure.consumer)} first`,
    "add a compatibility shim",
  ];
}

function nextMinor(component) {
  return component.replace(/@(\d+)\.(\d+)\.(\d+)$/, (_, major, minor) => {
    return `@${major}.${Number(minor) + 1}.0`;
  });
}

function componentVersion(value) {
  return `${value.component}@${value.version}`;
}

function parseTarget(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      return args[index + 1];
    }
    if (arg.startsWith("--target=")) {
      return arg.slice("--target=".length);
    }
  }

  return undefined;
}

function difference(required = [], provided = []) {
  const providedSet = new Set(provided);
  return sortedUnique(required).filter((field) => !providedSet.has(field));
}

function sortedUnique(values = []) {
  return [...new Set(values)].sort();
}
