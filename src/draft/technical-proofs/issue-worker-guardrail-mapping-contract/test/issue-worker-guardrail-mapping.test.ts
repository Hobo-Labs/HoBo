import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertIssueWorkerGuardrailMapping,
  issueWorkerGuardrailMappingRecord,
} from "../src/issue-worker-guardrail-mapping.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const automationDocPath = resolve(repoRoot, "docs/automations/hobo-issue-worker.md");

test("HOBO-702 mapping record pins six BR-011 / Plan 06 guardrail rows", () => {
  const record = issueWorkerGuardrailMappingRecord();

  assert.equal(record.parentIssue, "HOBO-702");
  assert.equal(record.automationDocPath, "docs/automations/hobo-issue-worker.md");
  assert.equal(record.rows.length, 6);
  assert.deepEqual(record.authoritativeRefs, ["BR-011", "Plan 06", "FR-022", "Plan 29", "ADR-0094"]);
});

test("automation doc cites BR-011 / Plan 06 guardrails with agent-native mapping", () => {
  const docText = readFileSync(automationDocPath, "utf8");
  const record = assertIssueWorkerGuardrailMapping(docText);

  assert.equal(record.parentIssue, "HOBO-702");
  assert.match(docText, /## Agent-native guardrails/);
  assert.match(docText, /BR-011/);
  assert.match(docText, /Plan 06/);
  assert.match(docText, /issue-worker-guardrail-mapping-contract/);
});

test("assertIssueWorkerGuardrailMapping fails closed when BR-011 citation is missing", () => {
  assert.throws(
    () => assertIssueWorkerGuardrailMapping("## Agent-native guardrails\nPlan 06 only"),
    /ISSUE_WORKER_GUARDRAIL_REF_MISSING/,
  );
});
