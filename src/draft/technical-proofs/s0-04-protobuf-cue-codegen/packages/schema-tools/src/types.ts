export type CodegenStatus = "CLEAN" | "DRIFT" | "ERROR";

export type DriftEntry = Readonly<{
  path: string;
  kind: "added" | "changed" | "removed";
}>;

export type CueViolation = Readonly<{
  package: string;
  constraint: string;
  message: string;
}>;

export type CodegenReport = Readonly<{
  status: CodegenStatus;
  drift: readonly DriftEntry[];
  cueViolations: readonly CueViolation[];
  durationMs: number;
}>;

export type DataModelPackage = Readonly<{
  name: string;
  packageDir: string;
  dataModelsDir: string;
  generatedDir: string;
  cueSchemas: readonly string[];
}>;

export type CodegenInvocation = Readonly<{
  repoRoot: string;
  packagesRoot: string;
  check: boolean;
  json: boolean;
  filter: string | undefined;
  bufTemplate: string;
  schemaToolsPackageDir: string;
}>;

export type CueVetResult = Readonly<{
  ok: boolean;
  violations: readonly CueViolation[];
}>;

export function parseCodegenStatus(value: string): CodegenStatus {
  if (value === "CLEAN" || value === "DRIFT" || value === "ERROR") return value;
  throw new Error(`invalid CodegenStatus: ${value}`);
}

export function createCodegenReport(input: {
  status: CodegenStatus;
  drift?: readonly DriftEntry[];
  cueViolations?: readonly CueViolation[];
  durationMs: number;
}): CodegenReport {
  if (input.durationMs < 0) {
    throw new Error("durationMs must be >= 0");
  }
  return Object.freeze({
    status: input.status,
    drift: Object.freeze([...(input.drift ?? [])]),
    cueViolations: Object.freeze([...(input.cueViolations ?? [])]),
    durationMs: input.durationMs,
  });
}

export function reportToJson(report: CodegenReport): string {
  return `${JSON.stringify({
    status: report.status,
    drift: report.drift.map((entry) => ({ path: entry.path, kind: entry.kind })),
    cueViolations: report.cueViolations.map((entry) => ({
      package: entry.package,
      constraint: entry.constraint,
      message: entry.message,
    })),
    durationMs: report.durationMs,
  })}\n`;
}

export function exitCodeForReport(report: CodegenReport): number {
  return report.status === "CLEAN" ? 0 : 1;
}
