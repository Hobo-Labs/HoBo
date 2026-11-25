import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  KNOWN_LIMITATIONS_REGISTER,
  parseKnownLimitationsRegister,
} from "../../../cx/known-limitations-register-contract/src/known-limitations-register.ts";

declare const parsedCrewMcpAutonomyLimitationBrand: unique symbol;

export type ParsedCrewMcpAutonomyLimitation = {
  readonly markdownRow: string;
  readonly contractRow: {
    readonly id: string;
    readonly state: string;
    readonly userVisibleImpact: string;
    readonly launchMessagingDisposition: string;
  };
  readonly [parsedCrewMcpAutonomyLimitationBrand]: "ParsedCrewMcpAutonomyLimitation";
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../");
const REGISTER_DOC = join(REPO_ROOT, "docs/design/known-limitations-register.md");

export function readKnownLimitationsRegisterDoc() {
  return readFileSync(REGISTER_DOC, "utf8");
}

export function findCrewMcpLimitationRow(markdown: string) {
  const tableBody = markdown.split("## Initial V1 Entries")[1]?.split("## Handoff Targets")[0] ?? "";
  const rows = tableBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.includes("---"));

  return rows.find((row) => /crew|mcp/i.test(row) && /policy-gated|unsupervised|autonom/i.test(row));
}

export function assertCrewMcpAutonomyLimitationRegistered(): ParsedCrewMcpAutonomyLimitation {
  const markdown = readKnownLimitationsRegisterDoc();
  const row = findCrewMcpLimitationRow(markdown);
  if (!row) {
    throw new Error("known-limitations register is missing a Crew/MCP autonomy row");
  }

  const parsed = parseKnownLimitationsRegister(structuredClone(KNOWN_LIMITATIONS_REGISTER));
  const contractRow = parsed.limitations.find((limitation) => limitation.id === "crew-mcp-write-actions-policy-gated");
  if (!contractRow) {
    throw new Error("known-limitations contract is missing crew-mcp-write-actions-policy-gated");
  }

  // SAFETY: `return {` is required at this I/O or test boundary.
  return {
    markdownRow: row,
    contractRow: {
      id: contractRow.id,
      state: contractRow.state,
      userVisibleImpact: contractRow.userVisibleImpact,
      launchMessagingDisposition: contractRow.launchMessagingDisposition,
    },
  } as ParsedCrewMcpAutonomyLimitation;
}
