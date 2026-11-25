import type { JsonValue } from "../json.js";
import type {
  Authorship,
  LaneReport,
  LaneStatus,
  SemanticsAnnexVector,
  SourceFileScan,
  VectorCaseResult,
} from "./types.js";

export function runThinIdiomLayerLane(sourceFiles: readonly SourceFileScan[]): LaneReport {
  const violations = assertThinIdiomLayer(sourceFiles);
  const violationsByPath = new Map<string, typeof violations>();

  for (const violation of violations) {
    const entries = violationsByPath.get(violation.path) ?? [];
    entries.push(violation);
    violationsByPath.set(violation.path, entries);
  }

  const cases: VectorCaseResult[] = sourceFiles.map((file) => {
    const fileViolations = violationsByPath.get(file.path) ?? [];
    if (fileViolations.length === 0) {
      return passedCase(file.path);
    }

    return failedCase(
      file.path,
      fileViolations.map((entry) => `${entry.reason}: ${entry.match}`).join("; "),
      { violations: [] },
      { violations: fileViolations },
      ["violations"],
    );
  });

  return Object.freeze({
    lane: "thin-idiom-layer",
    status: violations.length === 0 ? "passed" : "failed",
    cases,
  });
}

export function runAuthorshipLane(authorship: Authorship): LaneReport {
  const accepted = new Set<Authorship>(["hand-authored", "generated"]);
  const status: LaneStatus = accepted.has(authorship) ? "passed" : "failed";

  return Object.freeze({
    lane: "authorship-neutral-gate",
    status,
    cases: [
      status === "passed"
        ? passedCase(`${authorship}-uses-same-gate`)
        : failedCase(
            `${authorship}-uses-same-gate`,
            `unknown idiom-layer authorship: ${authorship}`,
            { authorship: "hand-authored|generated" },
            { authorship },
            ["authorship"],
          ),
    ],
  });
}

export function runCoverageLane(input: {
  corpusPath?: string;
  annexPath?: string;
  annexVectors: readonly SemanticsAnnexVector[];
  helperClaims?: readonly string[];
}): LaneReport {
  const coveredClaims = new Set(input.annexVectors.map((vector) => vector.name));

  const helperClaimCases: VectorCaseResult[] = (input.helperClaims ?? []).map((name) => {
    if (coveredClaims.has(name)) {
      return passedCase(name);
    }

    return failedCase(
      name,
      "helper claim has no golden-IR or semantics-annex vector",
      { covered: true },
      { covered: false },
      ["covered"],
    );
  });

  return Object.freeze({
    lane: "coverage-claim",
    status: helperClaimCases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    cases:
      helperClaimCases.length > 0
        ? helperClaimCases
        : [passedCase("no-helper-claims")],
  });
}

function passedCase(name: string): VectorCaseResult {
  return { name, status: "passed" };
}

function failedCase(
  name: string,
  reason: string,
  expected: JsonValue,
  actual: JsonValue,
  diffPaths: string[],
): VectorCaseResult {
  return {
    name,
    status: "failed",
    reason,
    expectedJson: JSON.stringify(expected),
    actualJson: JSON.stringify(actual),
    diffPaths,
  };
}

function assertThinIdiomLayer(files: readonly SourceFileScan[]) {
  const violations: { path: string; reason: string; match: string }[] = [];

  for (const file of files) {
    for (const specifier of importSpecifiers(file.source)) {
      if (isCloudProviderImport(specifier)) {
        violations.push({
          path: file.path,
          reason: "cloud/provider runtime import is not allowed in the idiom layer",
          match: specifier,
        });
      }
    }

    const hiddenDefault = /hiddenDefault\s*=\s*["']([^"']+)["']/.exec(file.source);
    const hiddenValue = hiddenDefault?.[1];
    if (hiddenValue && isProviderDefaultValue(hiddenValue)) {
      violations.push({
        path: file.path,
        reason: "provider default/credential logic is not allowed in the idiom layer",
        match: hiddenValue,
      });
    }
  }

  return violations;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /\bimport\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(source)) !== null) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function isCloudProviderImport(specifier: string): boolean {
  return [
    /^@aws-sdk\//,
    /^aws-sdk$/,
    /^@azure\//,
    /^@google-cloud\//,
    /^@pulumi\//,
    /^cloudflare$/,
    /^terraform$/,
  ].some((pattern) => pattern.test(specifier));
}

function isProviderDefaultValue(value: string): boolean {
  return /^(us-east-\d|us-west-\d|eastus|westus|AWS_|AZURE_|GOOGLE_)/.test(value);
}
