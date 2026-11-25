import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../");

export function readRepoDoc(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

export type WaitForTrackerRow = {
  aspire: string;
  hoboEquivalent: string;
  status: string;
  hoboDoc: string;
};

export function parseWaitForTrackerRow(aspireMd: string): WaitForTrackerRow | null {
  const rowPattern =
    /\|\s*`WaitFor`\s*\/\s*`WaitForCompletion`[^|]*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/;
  const match = aspireMd.match(rowPattern);
  if (!match) {
    return null;
  }
  return {
    aspire: "`WaitFor` / `WaitForCompletion` (health-gated)",
    hoboEquivalent: match[1].trim(),
    status: match[2].trim(),
    hoboDoc: match[3].trim(),
  };
}

export function auditAspireWaitForParity(aspireMd: string, controlPlaneMd: string): string[] {
  const failures: string[] = [];
  const row = parseWaitForTrackerRow(aspireMd);

  if (!row) {
    failures.push("aspire.md: WaitFor / WaitForCompletion tracker row not found");
    return failures;
  }

  if (row.status !== "◐") {
    failures.push(`aspire.md: WaitFor row status must be ◐, got ${row.status}`);
  }

  if (row.status === "✅") {
    failures.push("aspire.md: WaitFor row must not claim designed-at-parity (✅)");
  }

  if (!/resource\.Provisioned/i.test(row.hoboEquivalent)) {
    failures.push("aspire.md: WaitFor HoBo equivalent must mention resource.Provisioned-only gating");
  }

  if (!/not yet designed|iteration hook/i.test(row.hoboEquivalent + row.hoboDoc)) {
    failures.push(
      "aspire.md: WaitFor row must reference the health/readiness iteration hook or not-yet-designed gap",
    );
  }

  if (!row.hoboDoc.includes("health-gated-dependency-ordering-iteration-hook")) {
    failures.push("aspire.md: WaitFor row must link control-plane.md#health-gated-dependency-ordering-iteration-hook");
  }

  if (!controlPlaneMd.includes("### Health-gated dependency ordering (iteration hook)")) {
    failures.push("control-plane.md: missing Health-gated dependency ordering iteration hook subsection");
  }

  if (!/resource\.Provisioned/i.test(controlPlaneMd)) {
    failures.push("control-plane.md: iteration hook must document resource.Provisioned-only gating");
  }

  if (!aspireMd.includes("GAP-027")) {
    failures.push("aspire.md: WaitFor feature section must cite GAP-027");
  }

  return failures;
}
