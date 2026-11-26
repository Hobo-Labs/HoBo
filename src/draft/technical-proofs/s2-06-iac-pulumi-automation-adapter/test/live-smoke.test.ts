import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createInMemoryStateBackend,
  createPulumiAutomationAdapter,
  createTrivialIacProgram,
} from "../src/iac-pulumi-automation-adapter.js";

const liveEnabled = process.env.HOBO_IAC_PULUMI_LIVE === "1";

describe("live smoke — @hobo/iac-pulumi Automation API adapter", { skip: !liveEnabled }, () => {
  it("runs preview/apply/refresh/destroy on trivial program with isolated per-resource stacks", async () => {
    const stateBackend = createInMemoryStateBackend();
    const adapter = createPulumiAutomationAdapter({ stateBackend });
    const program = createTrivialIacProgram();

    const preview = await adapter.preview(program);
    assert.equal(preview.dirty, true);

    const outputs = await adapter.apply(program);
    assert.equal(outputs.resources.hello.status, "provisioned");
    assert.equal(outputs.bindings["stack.greeting"], "hello-bindle");

    const refresh = await adapter.refresh(program);
    assert.equal(refresh.drifted, false);

    const destroy = await adapter.destroy(program);
    assert.equal(destroy.resources.hello.status, "destroyed");
    assert.deepEqual(stateBackend.snapshot(), { "trivial-demo/hello": { resources: {} } });
  });
});

if (!liveEnabled) {
  describe("live smoke — @hobo/iac-pulumi Automation API adapter", () => {
    it("skips unless HOBO_IAC_PULUMI_LIVE=1 is set", () => {
      assert.equal(process.env.HOBO_IAC_PULUMI_LIVE, undefined);
    });
  });
}
