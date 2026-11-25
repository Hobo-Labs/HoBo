import assert from "node:assert/strict";
import { test } from "vitest";

import { validateStage6NotifySeparation } from "../src/stage6-notify-separation.ts";

test("stage-6 acceptance tables separate notify port from Plan 46 governance planes", () => {
  const result = validateStage6NotifySeparation();

  assert.equal(result.ok, true, result.errors.join("\n"));
});
