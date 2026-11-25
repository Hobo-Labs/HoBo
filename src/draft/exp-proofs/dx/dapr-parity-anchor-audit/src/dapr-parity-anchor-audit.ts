import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Parse, don't validate: markdown crosses this boundary once and becomes parsed
// domain types for downstream parity checks.

export const DAPR_COMPETITOR_DOC = "docs/competitors/dapr.md";

export const AUDITED_DAPR_FEATURES = ["Bindings", "Distributed lock"] as const;

export type AuditedDaprFeature = (typeof AUDITED_DAPR_FEATURES)[number];

interface AuditedFeatureRowMatchers {
  readonly Bindings: RegExp;
  readonly "Distributed lock": RegExp;
}

// domain-view: parse-produced draft-proof record; its wire form is the DaprParityRow proto message in data-models/.
export type DaprParityRow = {
  feature: AuditedDaprFeature;
  status: "✅" | "➕" | "🔜" | "↔";
  designAnchors: string[];
  notes: string;
};

export type DaprParityAudit = {
  issue: "HOBO-699";
  targetDoc: typeof DAPR_COMPETITOR_DOC;
  rows: DaprParityRow[];
};

const DESIGN_ANCHOR_PATTERN =
  /\[[^\]]+\]\(\.\.\/design\/[^)]+\)|\[[^\]]+\]\(\.\.\/design\/adr\/[^)]+\)/g;

function extractMappingRows(markdown: string): DaprParityRow[] {
  const rows: DaprParityRow[] = [];
  const mappingSection =
    markdown.split("## Primitive mapping")[1] ??
    markdown.split("## HoBo mapping")[1] ??
    markdown;

  const rowMatchers: AuditedFeatureRowMatchers = {
    Bindings:
      /\| \*\*Bindings\*\* \(input\/output connectors\) \|([^|]+)\|([^|]+)\|/,
    "Distributed lock":
      /\| \*\*Distributed lock\*\* \|([^|]+)\|([^|]+)\|/,
  };

  for (const feature of AUDITED_DAPR_FEATURES) {
    const match = mappingSection.match(rowMatchers[feature]);
    if (!match) {
      throw new Error(`missing HoBo mapping row for ${feature}`);
    }

    const equivalent = match[1]?.trim() ?? "";
    const notes = match[2]?.trim() ?? "";
    const statusMatch = notes.match(/^(✅|➕|🔜|↔)/);
    if (!statusMatch) {
      throw new Error(`missing parity status marker for ${feature}`);
    }

    // SAFETY: `const status = statusMatch[1] as DaprParityRow["status"];` is required at this I/O or test boundary.
    const status = statusMatch[1] as DaprParityRow["status"];
    const rowText = `${equivalent} ${notes}`;
    const designAnchors = [...rowText.matchAll(DESIGN_ANCHOR_PATTERN)].map((anchor) => anchor[0]);

    rows.push({
      feature,
      status,
      designAnchors,
      notes: rowText.trim(),
    });
  }

  return rows;
}

export function auditDaprParityAnchors(markdown: string): DaprParityAudit {
  return {
    issue: "HOBO-699",
    targetDoc: DAPR_COMPETITOR_DOC,
    rows: extractMappingRows(markdown),
  };
}

export function loadDaprParityAudit(repoRoot = process.cwd()): DaprParityAudit {
  const markdown = readFileSync(resolve(repoRoot, DAPR_COMPETITOR_DOC), "utf8");
  return auditDaprParityAnchors(markdown);
}

export function assertNoParityOverclaim(audit: DaprParityAudit): string[] {
  const violations: string[] = [];

  for (const row of audit.rows) {
    if (row.status === "✅" && row.designAnchors.length === 0) {
      violations.push(`${row.feature}: ✅ without design anchor`);
    }
    if (row.status === "✅") {
      violations.push(`${row.feature}: must not claim designed-at-parity (✅)`);
    }
    if (row.designAnchors.length === 0) {
      violations.push(`${row.feature}: missing design anchor links`);
    }
    if (row.status !== "🔜") {
      violations.push(`${row.feature}: expected 🔜 iteration-hook status, got ${row.status}`);
    }
  }

  return violations;
}
