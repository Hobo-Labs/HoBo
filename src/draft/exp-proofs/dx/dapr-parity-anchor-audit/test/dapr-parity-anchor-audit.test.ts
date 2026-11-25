import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";

import {
  AUDITED_DAPR_FEATURES,
  DAPR_COMPETITOR_DOC,
  assertNoParityOverclaim,
  auditDaprParityAnchors,
  loadDaprParityAudit,
} from "../src/dapr-parity-anchor-audit.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../../");

describe("dapr parity anchor audit", () => {
  it("pins HOBO-699 audited features and loads the live competitor doc", () => {
    const audit = loadDaprParityAudit(REPO_ROOT);

    assert.equal(audit.issue, "HOBO-699");
    assert.equal(audit.targetDoc, DAPR_COMPETITOR_DOC);
    assert.deepEqual(
      audit.rows.map((row) => row.feature),
      [...AUDITED_DAPR_FEATURES],
    );
  });

  it("requires Bindings and Distributed lock rows to stay 🔜 with design anchors", () => {
    const audit = loadDaprParityAudit(REPO_ROOT);

    for (const row of audit.rows) {
      assert.equal(row.status, "🔜", `${row.feature} must stay 🔜 until designed`);
      assert.ok(row.designAnchors.length > 0, `${row.feature} must cite design anchors`);
      assert.ok(
        row.notes.toLowerCase().includes("no unified bindings port") ||
          row.notes.toLowerCase().includes("no standalone lock port") ||
          row.notes.toLowerCase().includes("not a general lock"),
        `${row.feature} must state the honest gap`,
      );
    }

    assert.deepEqual(assertNoParityOverclaim(audit), []);
  });

  it("rejects bundled ✅ parity rows that hide bindings or distributed lock gaps", () => {
    const markdown = readFileSync(resolve(REPO_ROOT, DAPR_COMPETITOR_DOC), "utf8");

    assert.doesNotMatch(
      markdown,
      /\| \*\*State \/ pub\/sub \/ bindings/i,
      "bindings must not ride a bundled ✅ row",
    );
    assert.doesNotMatch(
      markdown,
      /lock \/ crypto \/ jobs\*\* \|[^|]+\|[^|]*✅[^|]*near 1:1/i,
      "distributed lock must not ride a bundled ✅ row",
    );
  });

  it("fails closed when a fixture row claims ✅ without anchors", () => {
    const fixture = `
## HoBo mapping
| **Bindings** (input/output connectors) | provider adapters only | ✅ near parity |
| **Distributed lock** | actor lease | ✅ designed |
`;

    const audit = auditDaprParityAnchors(fixture);
    const violations = assertNoParityOverclaim(audit);

    assert.ok(violations.length >= 4);
    assert.ok(violations.some((entry) => entry.includes("Bindings")));
    assert.ok(violations.some((entry) => entry.includes("Distributed lock")));
  });
});
