import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertClosureBuilderV1Finalization,
  closureBuilderV1FinalizationRecord,
  assertNoLegacyClosureBuilderFinalizationSyntax,
} from "../src/closure-builder-v1-finalization.ts";

test("HOBO-531 finalization record proves every closure-builder child or RCR issue has accepted evidence", () => {
  const result = assertClosureBuilderV1Finalization(closureBuilderV1FinalizationRecord());

  assert.equal(result.parentIssue, "HOBO-531");
  assert.deepEqual(
    result.evidence.map((entry) => entry.issueId),
    ["HOBO-532", "HOBO-533", "HOBO-534", "HOBO-535", "HOBO-536", "HOBO-537", "HOBO-538"],
  );
  assert.equal(result.evidence.every((entry) => entry.linearStatus === "Done"), true);
  assert.equal(result.evidence.every((entry) => entry.proofPath.startsWith("src/draft/")), true);
});

test("finalization rejects legacy explicit-Bindle syntax and non-done child evidence", () => {
  assert.throws(
    () =>
      assertClosureBuilderV1Finalization({
        ...closureBuilderV1FinalizationRecord(),
        evidence: [
          {
            issueId: "HOBO-532",
            linearStatus: "In Review",
            proofPath: "src/draft/closure-builder-public-api-contract/README.md",
            evidenceRef: "urn:hobo:requirement:closure-builder-public-api",
            acceptedScope: "public API vocabulary",
          },
        ],
      }),
    /CLOSURE_BUILDER_V1_UNACCEPTED_EVIDENCE/,
  );

  assert.throws(
    () =>
      assertNoLegacyClosureBuilderFinalizationSyntax(`
        export default bindle("shop", b => {
          const db = b.use(database("db"));
          return { db };
        });
      `),
    /CLOSURE_BUILDER_V1_LEGACY_SYNTAX/,
  );
});
