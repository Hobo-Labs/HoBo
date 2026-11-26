import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { DevParseError, parseDevPort, parseDevStateSnapshot } from "../src/types.js";
import { DevStateStore, projectDevState } from "../src/dev-state-store.js";
import { type JsonValue } from "../src/json.js";


describe("dev state store", () => {
  it("projects request events into runCount and requests", () => {
    const state = projectDevState([
      {
        sequence: 1,
        family: "dev.SessionStarted",
        at: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
      {
        sequence: 2,
        family: "dev.RequestServed",
        at: "2026-01-01T00:00:01.000Z",
        payload: { path: "/a", body: { id: 1 } },
      },
    ]);
    assert.equal(state.runCount, 1);
    assert.equal(state.eventSequence, 2);
    assert.equal(state.requests[0]?.path, "/a");
  });

  it("fail-closed on foreign schema version at parse boundary", () => {
    assert.throws(
      () => parseDevStateSnapshot({ schema: "hobo.dev-state/v0", runCount: 1 }),
      (error: JsonValue) => {
        assert.ok(error instanceof DevParseError);
        assert.equal(error.code, "HOBO_DEV_STATE_VERSION_UNSUPPORTED");
        return true;
      },
    );
  });

  it("rejects invalid port at parse boundary", () => {
    assert.throws(() => parseDevPort(80), DevParseError);
    assert.throws(() => parseDevPort(70000), DevParseError);
    assert.equal(parseDevPort(4000), 4000);
  });

  it("persists append-only events and snapshot projection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hobo-612-state-"));
    try {
      const store = new DevStateStore(root);
      await store.append({ family: "dev.SessionStarted", payload: {} });
      const state = await store.append({
        family: "dev.RequestServed",
        payload: { path: "/health", body: {} },
      });
      assert.equal(state.runCount, 1);
      const reloaded = new DevStateStore(root);
      const replay = await reloaded.load();
      assert.equal(replay.runCount, 1);
      assert.equal(reloaded.events().length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
