import { readFileSync } from "node:fs";
import path from "node:path";

/** Parse, don't validate: markdown tables cross one boundary into parsed domain types. */

export type AspireHostingTestingTrackerStatus =
  | "parity"
  | "deferred"
  | "planned"
  | "overclaimed";

// domain-view: parse-produced draft-proof record; its wire form is the AspireHostingTestingTrackerEvaluation proto message in data-models/.
export type AspireHostingTestingTrackerEvaluation = {
  readonly feature: "Aspire.Hosting.Testing";
  readonly status: AspireHostingTestingTrackerStatus;
  readonly hasWholeGraphHarnessSpec: boolean;
  readonly ok: boolean;
  readonly reason: string;
};

export class ParsedAspireHostingTestingTrackerEvaluation {
  readonly value: AspireHostingTestingTrackerEvaluation;

  private constructor(value: AspireHostingTestingTrackerEvaluation) {
    this.value = value;
  }

  static fromMarkdown(input: {
    aspireMarkdown: string;
    generatedStackMarkdown: string;
  }): ParsedAspireHostingTestingTrackerEvaluation {
    return new ParsedAspireHostingTestingTrackerEvaluation(
      evaluateAspireHostingTestingTracker(input),
    );
  }
}

const HOSTING_TESTING_ROW =
  /\|\s*`Aspire\.Hosting\.Testing`\s*\|[^|\n]*\|\s*(✅|◐|🔜)\s*\|/u;

const WHOLE_GRAPH_HOOK =
  /### Whole-graph in-process test harness \(iteration hook\)/u;

export function evaluateAspireHostingTestingTracker(input: {
  aspireMarkdown: string;
  generatedStackMarkdown: string;
}): AspireHostingTestingTrackerEvaluation {
  const rowMatch = input.aspireMarkdown.match(HOSTING_TESTING_ROW);
  if (!rowMatch) {
    return {
      feature: "Aspire.Hosting.Testing",
      status: "overclaimed",
      hasWholeGraphHarnessSpec: false,
      ok: false,
      reason: "Aspire.Hosting.Testing tracker row is missing from aspire.md.",
    };
  }

  const statusGlyph = rowMatch[1];
  const hasWholeGraphHarnessSpec = WHOLE_GRAPH_HOOK.test(input.generatedStackMarkdown);
  const status =
    statusGlyph === "✅"
      ? "parity"
      : statusGlyph === "◐"
        ? "deferred"
        : "planned";

  if (status === "parity" && !hasWholeGraphHarnessSpec) {
    return {
      feature: "Aspire.Hosting.Testing",
      status: "overclaimed",
      hasWholeGraphHarnessSpec,
      ok: false,
      reason:
        "Aspire.Hosting.Testing is marked ✅ without a whole-graph harness spec in Plan 09.",
    };
  }

  if (status === "deferred" && !hasWholeGraphHarnessSpec) {
    return {
      feature: "Aspire.Hosting.Testing",
      status: "overclaimed",
      hasWholeGraphHarnessSpec,
      ok: false,
      reason:
        "Aspire.Hosting.Testing is marked ◐ without the Plan 09 whole-graph harness iteration hook.",
    };
  }

  return {
    feature: "Aspire.Hosting.Testing",
    status,
    hasWholeGraphHarnessSpec,
    ok: true,
    reason:
      status === "deferred"
        ? "Tracker row is ◐ and whole-graph harness gap is documented."
        : "Tracker row is not ✅ or whole-graph harness spec exists.",
  };
}

export function assertAspireHostingTestingTracker(input: {
  aspireMarkdown: string;
  generatedStackMarkdown: string;
}): AspireHostingTestingTrackerEvaluation {
  const result = ParsedAspireHostingTestingTrackerEvaluation.fromMarkdown(input).value;
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result;
}

export function loadRepoAspireHostingTestingTracker(repoRoot: string) {
  const aspirePath = path.join(repoRoot, "docs/competitors/aspire.md");
  const generatedStackPath = path.join(repoRoot, "docs/design/generated-stack.md");
  return evaluateAspireHostingTestingTracker({
    aspireMarkdown: readFileSync(aspirePath, "utf8"),
    generatedStackMarkdown: readFileSync(generatedStackPath, "utf8"),
  });
}
