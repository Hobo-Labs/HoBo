import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolve } from "node:path";

import { checkUiGenerationCitations } from "../src/ui-generation-citation.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../..");

describe("ADR-0064 UI generation citation contract (HOBO-704 / REM-037)", () => {
  it("does not mis-cite app/UI generation as out of scope in the four REM-037 targets", () => {
    const results = checkUiGenerationCitations(REPO_ROOT);
    const failures = results.filter((result) => !result.ok);

    assert.deepEqual(
      failures,
      [],
      failures
        .map((failure) => `${failure.path}: ${failure.violations.join("; ")}`)
        .join("\n"),
    );
  });
});
