import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { PINNED_TOOLCHAIN, componentizeHelloBindle } from "../../../../../packages/componentize/src/index.js";
import { defaultComponentize } from "../src/componentize-adapter.js";

const pactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "cli-componentize-boundary.pact.json",
);

test("cli-componentize boundary pact satisfies success and fail-closed interactions", async () => {
  const pact = JSON.parse(readFileSync(pactPath, "utf8"));

  assert.equal(pact.consumer.name, "@hobo/cli");
  assert.equal(pact.provider.name, "@hobo/componentize");

  const success = await defaultComponentize({
    sourceRoot: fileURLToPath(
      new URL("../../../../../packages/componentize/test/fixtures/hello-bindle", import.meta.url),
    ),
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(
    success.component.mediaType,
    pact.interactions[0].response.body.component.mediaType,
  );

  await assert.rejects(
    () =>
      componentizeHelloBindle({
        sourceRoot: new URL(
          "../../../../../packages/componentize/test/fixtures/hello-bindle",
          import.meta.url,
        ),
        sourceDateEpoch: "2026-01-01T00:00:00.000Z",
        toolchain: { ...PINNED_TOOLCHAIN, jco: "1.24.4" },
      }),
    /componentize\.toolchain_skew/,
  );
});
