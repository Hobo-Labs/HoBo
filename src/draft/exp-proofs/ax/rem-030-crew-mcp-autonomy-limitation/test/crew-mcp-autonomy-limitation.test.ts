import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertCrewMcpAutonomyLimitationRegistered,
  findCrewMcpLimitationRow,
  readKnownLimitationsRegisterDoc,
} from "../src/crew-mcp-autonomy-limitation.ts";

test("Given the known-limitations register, When scanning Initial V1 Entries, Then a Crew/MCP autonomy row exists", () => {
  const markdown = readKnownLimitationsRegisterDoc();
  const row = findCrewMcpLimitationRow(markdown);

  assert.ok(row, "expected Crew/MCP limitation row in Initial V1 Entries table");
  assert.match(row ?? "", /policy-gated|unsupervised/i);
  assert.match(row ?? "", /Crew|MCP/i);
});

test("Given HOBO-697 acceptance, When contract and design doc are checked together, Then Crew/MCP write autonomy is policy-gated", () => {
  const { contractRow } = assertCrewMcpAutonomyLimitationRegistered();

  assert.equal(contractRow.state, "real");
  assert.match(contractRow.userVisibleImpact, /approval|policy gate/i);
  assert.match(contractRow.launchMessagingDisposition, /unsupervised/i);
});
