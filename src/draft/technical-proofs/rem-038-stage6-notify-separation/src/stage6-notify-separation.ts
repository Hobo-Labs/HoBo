import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STAGE6_DOC = resolve(
  import.meta.dirname,
  "../../../../../docs/design/stage-6-production-hardening-acceptance.md"
);

export type TableSeparationResult = {
  ok: boolean;
  errors: string[];
};

function extractScopeInTable(markdown: string): string {
  const start = markdown.indexOf("## Scope In");
  const end = markdown.indexOf("## Scope Out", start);
  if (start === -1 || end === -1) {
    throw new Error("Scope In section not found");
  }
  return markdown.slice(start, end);
}

function extractEvidenceTable(markdown: string): string {
  const start = markdown.indexOf("## Evidence Required");
  const end = markdown.indexOf("## Follow-Up Gate", start);
  if (start === -1 || end === -1) {
    throw new Error("Evidence Required section not found");
  }
  return markdown.slice(start, end);
}

function laneRows(tableSection: string): string[] {
  return tableSection
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.startsWith("| Lane"));
}

function laneName(row: string): string {
  const cells = row.split("|").map((cell) => cell.trim());
  return cells[1] ?? "";
}

export function validateStage6NotifySeparation(
  markdown = readFileSync(STAGE6_DOC, "utf8")
): TableSeparationResult {
  const errors: string[] = [];
  const scopeRows = laneRows(extractScopeInTable(markdown));
  const evidenceRows = laneRows(extractEvidenceTable(markdown));

  const notifyScope = scopeRows.find((row) => /`notify` port/i.test(laneName(row)));
  const governanceScope = scopeRows.find((row) =>
    /Governance planes \(Plan 46\)/i.test(laneName(row))
  );
  const bundledScope = scopeRows.find((row) => /^Governance planes$/i.test(laneName(row)));

  if (!notifyScope) {
    errors.push("Scope In missing dedicated `notify` port row");
  } else if (/Plan 46/i.test(laneName(notifyScope))) {
    errors.push("Scope In `notify` lane name must not be a Plan 46 governance plane");
  }

  if (!governanceScope) {
    errors.push("Scope In missing Governance planes (Plan 46) row");
  } else if (/ADR-0059|consent-gated send/i.test(governanceScope)) {
    errors.push("Scope In governance row must not bundle notify port evidence");
  }

  if (bundledScope) {
    errors.push('Scope In still has undifferentiated "Governance planes" row');
  }

  const notifyEvidence = evidenceRows.find((row) => /`notify` port/i.test(laneName(row)));
  const governanceEvidence = evidenceRows.find((row) =>
    /Governance planes \(Plan 46\)/i.test(laneName(row))
  );
  const bundledEvidence = evidenceRows.find((row) =>
    /^Governance planes$/i.test(laneName(row))
  );

  if (!notifyEvidence) {
    errors.push("Evidence Required missing dedicated `notify` port row");
  }
  if (!governanceEvidence) {
    errors.push("Evidence Required missing Governance planes (Plan 46) row");
  }
  if (bundledEvidence) {
    errors.push('Evidence Required still bundles notify into "Governance planes" row');
  }

  if (!/Seven stage-6 implementation lanes/i.test(markdown)) {
    errors.push("Scope In intro must say seven lanes after notify/governance split");
  }

  return { ok: errors.length === 0, errors };
}
