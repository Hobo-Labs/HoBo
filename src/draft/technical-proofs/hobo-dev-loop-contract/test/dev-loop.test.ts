import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { scaffoldHoboProject } from "../../hobo-new-scaffold-contract/src/scaffold.js";
import { writeFixtureProject } from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import {
  HoboDevError,
  createForkLane,
  createHoboDevLoop,
  defineDevResource,
} from "../src/dev-loop.js";

async function withProject(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "hobo-dev-loop-"));
  try {
    const { projectDir } = await scaffoldHoboProject({ cwd: root, name: "snapshop", template: "api" });
    await writeFixtureProject(projectDir);
    return await callback(projectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("hobo dev loop contract", () => {
  it("boots a hobo new project on localhost in under a minute with no cloud account", async () => {
    await withProject(async (projectRoot) => {
      const loop = createHoboDevLoop({ bootMs: 950 });
      const session = await loop.start({
        projectRoot,
        resources: [
          defineDevResource("api", "main"),
          defineDevResource("data", "catalog"),
          defineDevResource("queue", "jobs"),
          defineDevResource("secret", "stripe"),
        ],
        campOnlyCapabilities: ["cross-cloud-mtls"],
      });

      assert.equal(session.localUrl, "http://localhost:4000");
      assert.equal(session.cloudAccountRequired, false);
      assert.equal(session.bootedInMs < 60_000, true);
      assert.equal(session.state.runCount, 0);
      assert.deepEqual(session.fidelityLabels, {
        main: "real",
        catalog: "simulated",
        jobs: "simulated",
        stripe: "mocked",
        "cross-cloud-mtls": "camp-only",
      });
    });
  });

  it("hot-reloads handler edits without losing run state", async () => {
    await withProject(async (projectRoot) => {
      const loop = createHoboDevLoop();
      await loop.start({ projectRoot, resources: [defineDevResource("api", "main")] });
      const before = await loop.handleRequest({ path: "/photos", body: { id: "p1" } });

      const reload = await loop.reloadHandler({
        path: "app.ts",
        source: "export const handler = () => ({ ok: true, version: 2 });",
      });
      const after = await loop.handleRequest({ path: "/photos", body: { id: "p2" } });

      assert.equal(reload.ok, true);
      assert.equal(loop.daemonAlive(), true);
      assert.equal(before.state.runCount, 1);
      assert.equal(after.state.runCount, 2);
      assert.deepEqual(after.state.requests.map((request) => request.body.id), ["p1", "p2"]);
    });
  });

  it("restarts from .hobo state and replays to the same local state", async () => {
    await withProject(async (projectRoot) => {
      const first = createHoboDevLoop();
      await first.start({ projectRoot, resources: [defineDevResource("api", "main")] });
      await first.handleRequest({ path: "/checkout", body: { order: "o1" } });
      await first.handleRequest({ path: "/checkout", body: { order: "o2" } });

      const restarted = createHoboDevLoop();
      const session = await restarted.start({ projectRoot, resources: [defineDevResource("api", "main")] });
      const replay = await restarted.replayPersistedState();

      assert.deepEqual(session.state, replay);
      assert.equal(replay.runCount, 2);
      assert.deepEqual(replay.requests.map((request) => request.body.order), ["o1", "o2"]);
    });
  });

  it("regenerates checked-in generated code after a Zod source edit and debounces concurrent saves", async () => {
    await withProject(async (projectRoot) => {
      const loop = createHoboDevLoop();
      await loop.start({ projectRoot, resources: [defineDevResource("api", "main")] });
      await loop.flushWatch();
      const before = await readFile(path.join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");

      const zodPath = path.join(projectRoot, ".hobo/sources/zod/resources.json");
      const zod = JSON.parse(await readFile(zodPath, "utf8"));
      zod.resources.ticket.fields.description = { type: "string" };
      await writeFile(zodPath, `${JSON.stringify(zod, null, 2)}\n`);

      loop.queueSourceChange(".hobo/sources/zod/resources.json");
      loop.queueSourceChange(".hobo/sources/zod/resources.json");
      const flushed = await loop.flushWatch();
      const after = await readFile(path.join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");

      assert.equal(flushed.codegenRuns, 1);
      assert.notEqual(after, before);
      assert.match(after, /description: string;/);
    });
  });

  it("reports syntax reload errors without crashing the daemon or dropping state", async () => {
    await withProject(async (projectRoot) => {
      const loop = createHoboDevLoop();
      await loop.start({ projectRoot, resources: [defineDevResource("api", "main")] });
      await loop.handleRequest({ path: "/ok", body: { ok: true } });

      const reload = await loop.reloadHandler({
        path: "app.ts",
        source: "export const handler = ",
      });
      const after = loop.currentState();

      assert.equal(reload.ok, false);
      assert.equal(reload.code, "HOBO_DEV_RELOAD_ERROR");
      assert.equal(reload.daemonAlive, true);
      assert.match(reload.message, /app\.ts/);
      assert.equal(loop.daemonAlive(), true);
      assert.equal(after.runCount, 1);
    });
  });

  it("rejects incompatible .hobo state without corrupting the stored state file", async () => {
    await withProject(async (projectRoot) => {
      const statePath = path.join(projectRoot, ".hobo/dev-state.json");
      const staleState = "{\n  \"schema\": \"hobo.dev-state/v0\",\n  \"runCount\": 12\n}\n";
      await writeFile(statePath, staleState);

      const loop = createHoboDevLoop();

      await assert.rejects(
        () => loop.start({ projectRoot, resources: [defineDevResource("api", "main")] }),
        (error) => {
          assert.ok(error instanceof HoboDevError);
          assert.equal(error.code, "HOBO_DEV_STATE_VERSION_UNSUPPORTED");
          return true;
        },
      );
      assert.equal(await readFile(statePath, "utf8"), staleState);
    });
  });

  it("--fork lane writes stay isolated from the shared environment baseline", () => {
    const shared = { "inventory:sku-1": 3, "cart:user-1": 1 };
    const lane = createForkLane({ service: "cart", into: "staging", shared });

    lane.write("inventory:sku-1", 0);
    lane.write("cart:user-1", 2);

    assert.equal(lane.read("inventory:sku-1"), 0);
    assert.equal(lane.read("cart:user-1"), 2);
    assert.deepEqual(shared, { "inventory:sku-1": 3, "cart:user-1": 1 });
    assert.deepEqual(lane.diff(), {
      service: "cart",
      into: "staging",
      writes: {
        "cart:user-1": { baseline: 1, lane: 2 },
        "inventory:sku-1": { baseline: 3, lane: 0 },
      },
    });
  });
});
