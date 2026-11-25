import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertClosureBuilderV1Finalization,
  closureBuilderV1FinalizationRecord,
  assertNoLegacyClosureBuilderFinalizationSyntax,
} from "../src/closure-builder-v1-finalization.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

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

test("repo docs lead the v1 Bindle authoring path with closure builder and link the finalization proof", () => {
  const designIndex = readFileSync(resolve(repoRoot, "docs/design/index.md"), "utf8");
  const sdkContracts = readFileSync(resolve(repoRoot, "docs/design/sdk-contracts.md"), "utf8");
  const publicApi = readFileSync(resolve(repoRoot, "docs/design/closure-builder-public-api.md"), "utf8");

  assert.match(designIndex, /\[.*closure-builder-public-api\.md.*\].*V1 explicit Bindle closure-builder public contract/);
  assert.match(sdkContracts, /bindle\(name, builderFn\).*closure builder/s);
  assert.match(publicApi, /Source issues: HOBO-531, HOBO-532, HOBO-533, HOBO-534, HOBO-535, HOBO-536, HOBO-537, and HOBO-538/);
  assert.match(publicApi, /closure-builder-v1-finalization-contract/);
});

test("traceability has a parent HOBO-531 row and still carries every child proof row", () => {
  const traceability = readFileSync(resolve(repoRoot, "docs/design/traceability.md"), "utf8");

  for (const issueId of ["HOBO-531", "HOBO-532", "HOBO-533", "HOBO-534", "HOBO-535", "HOBO-536", "HOBO-537", "HOBO-538"]) {
    assert.match(traceability, new RegExp(`\\| ${issueId} \\|`), `${issueId} missing traceability row`);
  }
  assert.match(traceability, /closure-builder-v1-finalization-contract/);
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
            designPath: "docs/design/closure-builder-public-api.md",
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
