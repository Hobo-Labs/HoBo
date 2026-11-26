import assert from "node:assert/strict";
import { test } from "vitest";
import {
  auditAspireWaitForParity,
  parseWaitForTrackerRow,
  readRepoDoc,
} from "../src/aspire-waitfor-parity-audit.ts";

test("parses the WaitFor tracker row from aspire.md", () => {
  const aspireMd = readRepoDoc("docs/competitors/aspire.md");
  const row = parseWaitForTrackerRow(aspireMd);

  assert.ok(row);
  assert.equal(row.status, "◐");
  assert.match(row.hoboEquivalent, /resource\.Provisioned/i);
});

test("aspire WaitFor parity audit passes against live docs", () => {
  const aspireMd = readRepoDoc("docs/competitors/aspire.md");
  const controlPlaneMd = readRepoDoc("docs/design/control-plane.md");
  const failures = auditAspireWaitForParity(aspireMd, controlPlaneMd);

  assert.deepEqual(failures, []);
});
