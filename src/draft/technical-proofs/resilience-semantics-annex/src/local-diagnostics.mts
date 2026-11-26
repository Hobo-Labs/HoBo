import { fileURLToPath } from "node:url";

import { canonicalResilienceFixtures } from "./resilience-semantics-annex.mjs";

type Fact = Readonly<{
  type: string;
  attempt?: number;
  atMs: number;
  delayMs?: number;
  source?: string;
}>;

type LocalDiagnosticFixture = Readonly<{
  name: string;
  outcome: DiagnosticOutcome;
  source?: string;
  facts: readonly Fact[];
}>;

type DiagnosticOutcome = "transient-retry" | "policy-denied" | "caller-cancelled" | "deadline-expired";

type RetriedAttempt = Readonly<{
  from: number;
  to: number;
  delayMs: number;
  causedBy: string;
}>;

type LocalDiagnosticScenario = Readonly<{
  name: string;
  outcome: DiagnosticOutcome;
  source: "replay-derived-persisted-facts";
  terminalCauses: readonly string[];
  retriedAttempts: readonly RetriedAttempt[];
  cleanupFacts: readonly string[];
  escalationFacts: readonly string[];
  freshAttemptAfterTerminal: boolean;
}>;

type LocalDiagnosticReport = Readonly<{
  command: "npm.cmd --prefix src\\draft\\resilience-semantics-annex run diagnostics";
  source: "replay-derived-persisted-facts";
  scenarios: readonly LocalDiagnosticScenario[];
  guarantees: Readonly<{
    requiresEffectOrXState: false;
    authoritativeState: "persisted-facts-only";
  }>;
}>;

const COMMAND = "npm.cmd --prefix src\\draft\\resilience-semantics-annex run diagnostics" as const;

const DEFAULT_SCENARIOS = Object.freeze([
  ["transient-retry-schedule", "transient-retry"],
  ["denial-never-retries", "policy-denied"],
  ["cancellation-stops-retry", "caller-cancelled"],
  ["deadline-escalates-from-state", "deadline-expired"],
] as const);

export function buildLocalDiagnosticReport(
  fixtures: readonly LocalDiagnosticFixture[] = defaultDiagnosticFixtures(),
): LocalDiagnosticReport {
  const scenarios = fixtures.map(toDiagnosticScenario);

  return {
    command: COMMAND,
    source: "replay-derived-persisted-facts",
    scenarios,
    guarantees: {
      requiresEffectOrXState: false,
      authoritativeState: "persisted-facts-only",
    },
  };
}

export function renderLocalDiagnostics(report = buildLocalDiagnosticReport()): string {
  const lines = [
    `command=${report.command}`,
    `source=${report.source}`,
    `guarantees=effect-xstate-not-required, ${report.guarantees.authoritativeState}`,
  ];

  for (const scenario of report.scenarios) {
    if (scenario.outcome === "transient-retry") {
      lines.push(
        `scenario=${scenario.outcome} terminalCauses=${formatList(scenario.terminalCauses)} retried=${scenario.retriedAttempts
          .map((attempt) => `${attempt.from}->${attempt.to}(${attempt.delayMs}ms, causedBy=${attempt.causedBy})`)
          .join(", ")}`,
      );
      continue;
    }

    if (scenario.outcome === "caller-cancelled") {
      lines.push(
        `scenario=${scenario.outcome} terminalCauses=${formatList(scenario.terminalCauses)} cleanup=${formatList(scenario.cleanupFacts)}`,
      );
      continue;
    }

    if (scenario.outcome === "deadline-expired") {
      lines.push(
        `scenario=${scenario.outcome} escalation=${formatList(scenario.escalationFacts)} freshAttemptAfterTerminal=${String(
          scenario.freshAttemptAfterTerminal,
        )}`,
      );
      continue;
    }

    lines.push(`scenario=${scenario.outcome} terminalCauses=${formatList(scenario.terminalCauses)}`);
  }

  return `${lines.join("\n")}\n`;
}

function defaultDiagnosticFixtures(): readonly LocalDiagnosticFixture[] {
  return DEFAULT_SCENARIOS.map(([name, outcome]) => {
    const fixture = canonicalResilienceFixtures.find((entry) => entry.name === name);
    if (!fixture) {
      throw new Error(`diagnostic.missing_fixture:${name}`);
    }

    return {
      name: fixture.name,
      outcome,
      facts: fixture.facts,
    };
  });
}

function toDiagnosticScenario(fixture: LocalDiagnosticFixture): LocalDiagnosticScenario {
  if (fixture.source === "object-memory" || fixture.facts.some((fact) => fact.source === "object-memory")) {
    throw new Error("diagnostic.stale_state_source");
  }

  const facts = [...fixture.facts].sort((left, right) => left.atMs - right.atMs || left.type.localeCompare(right.type));
  const terminalAt = terminalOrEscalationAt(facts);

  return {
    name: fixture.name,
    outcome: fixture.outcome,
    source: "replay-derived-persisted-facts",
    terminalCauses: terminalCausesFor(fixture.outcome),
    retriedAttempts: retryAttempts(facts),
    cleanupFacts: facts.filter((fact) => fact.type.startsWith("cleanup.")).map((fact) => fact.type),
    escalationFacts: facts.filter((fact) => fact.type === "deadline.Expired" || fact.type === "workflow.Escalated").map((fact) => fact.type),
    freshAttemptAfterTerminal: terminalAt === undefined ? false : facts.some((fact) => fact.type === "effect.Attempted" && fact.atMs > terminalAt),
  };
}

function retryAttempts(facts: readonly Fact[]): readonly RetriedAttempt[] {
  return facts
    .filter((fact) => fact.type === "retry.Scheduled" && fact.attempt !== undefined && fact.delayMs !== undefined)
    .map((retry) => ({
      from: retry.attempt! - 1,
      to: retry.attempt!,
      delayMs: retry.delayMs!,
      causedBy: priorFailureType(facts, retry.attempt! - 1),
    }));
}

function priorFailureType(facts: readonly Fact[], attempt: number): string {
  return facts.find((fact) => fact.attempt === attempt && (fact.type === "provider.Failed" || fact.type === "sdk.Failed"))?.type ?? "unknown";
}

function terminalCausesFor(outcome: DiagnosticOutcome): readonly string[] {
  if (outcome === "policy-denied") {
    return ["policy.Decided"];
  }
  if (outcome === "caller-cancelled") {
    return ["caller.Cancelled", "cleanup.Emitted"];
  }
  if (outcome === "transient-retry") {
    return ["effect.Succeeded"];
  }
  return [];
}

function terminalOrEscalationAt(facts: readonly Fact[]): number | undefined {
  return facts.find((fact) => fact.type === "workflow.Terminal" || fact.type === "workflow.Escalated" || fact.type === "effect.Succeeded")?.atMs;
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(renderLocalDiagnostics());
}
