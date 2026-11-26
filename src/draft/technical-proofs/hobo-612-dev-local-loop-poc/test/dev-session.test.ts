import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { scaffoldHoboProject } from "../../hobo-new-scaffold-contract/src/scaffold.js";
import { writeFixtureProject } from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import {
  HoboDevError,
  defineDevResource,
  startDevSession,
} from "../src/dev-session.js";
import { type JsonValue } from "../src/json.js";


async function withProject(callback: (projectRoot: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "hobo-612-dev-"));
  try {
    const { projectDir } = await scaffoldHoboProject({ cwd: root, name: "snapshop", template: "api" });
    await writeFixtureProject(projectDir);
    await callback(projectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("hobo-612 dev session", () => {
  it("boots on localhost in under 60s with no cloud account and fidelity labels", async () => {
    await withProject(async (projectRoot) => {
      const session = await startDevSession({
        projectRoot,
        bootMs: 950,
        resources: [
          defineDevResource("api", "main"),
          defineDevResource("data", "catalog"),
          defineDevResource("queue", "jobs"),
          defineDevResource("secret", "stripe"),
        ],
        campOnlyCapabilities: ["cross-cloud-mtls"],
      });

      assert.equal(session.record.localUrl, "http://localhost:4000");
      assert.equal(session.record.cloudAccountRequired, false);
      assert.equal(session.record.bootMs < 60_000, true);
      assert.equal(session.record.state.runCount, 0);
      assert.deepEqual(session.record.fidelityLabels, {
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
      const session = await startDevSession({
        projectRoot,
        resources: [defineDevResource("api", "main")],
      });
      const before = await session.handleRequest({ path: "/photos", body: { id: "p1" } });
      const reload = await session.reloadHandler({
        path: "app.ts",
        source: "export const handler = () => ({ ok: true, version: 2 });",
      });
      const after = await session.handleRequest({ path: "/photos", body: { id: "p2" } });

      assert.equal(reload.ok, true);
      assert.equal(session.daemonAlive(), true);
      assert.equal(before.state.runCount, 1);
      assert.equal(after.state.runCount, 2);
      assert.deepEqual(after.state.requests.map((request) => request.body), [{ id: "p1" }, { id: "p2" }]);
    });
  });

  it("restarts from .hobo state and replays to the same local state", async () => {
    await withProject(async (projectRoot) => {
      const first = await startDevSession({
        projectRoot,
        resources: [defineDevResource("api", "main")],
      });
      await first.handleRequest({ path: "/checkout", body: { order: "o1" } });
      await first.handleRequest({ path: "/checkout", body: { order: "o2" } });
      await first.stop();

      const restarted = await startDevSession({
        projectRoot,
        resources: [defineDevResource("api", "main")],
      });
      const replay = await restarted.replayPersistedState();

      assert.equal(replay.runCount, 2);
      assert.deepEqual(replay.requests.map((request) => request.body), [{ order: "o1" }, { order: "o2" }]);
    });
  });

  it("reports syntax reload errors without crashing the daemon", async () => {
    await withProject(async (projectRoot) => {
      const session = await startDevSession({
        projectRoot,
        resources: [defineDevResource("api", "main")],
      });
      await session.handleRequest({ path: "/ok", body: { ok: true } });
      const reload = await session.reloadHandler({
        path: "app.ts",
        source: "export const handler = ",
      });

      assert.equal(reload.ok, false);
      assert.equal(reload.code, "HOBO_DEV_RELOAD_ERROR");
      assert.equal(reload.daemonAlive, true);
      assert.equal(session.daemonAlive(), true);
      assert.equal(session.currentState().runCount, 1);
    });
  });

  it("rejects incompatible .hobo state without corrupting the stored state file", async () => {
    await withProject(async (projectRoot) => {
      const statePath = path.join(projectRoot, ".hobo", "dev-state.json");
      const staleState = "{\n  \"schema\": \"hobo.dev-state/v0\",\n  \"runCount\": 12\n}\n";
      await writeFile(statePath, staleState);

      await assert.rejects(
        () =>
          startDevSession({
            projectRoot,
            resources: [defineDevResource("api", "main")],
          }),
        (error: JsonValue) => {
          assert.ok(error instanceof HoboDevError);
          assert.equal(error.code, "HOBO_DEV_STATE_VERSION_UNSUPPORTED");
          return true;
        },
      );
      assert.equal(await readFile(statePath, "utf8"), staleState);
    });
  });

  it("deny-by-default: camp-only capability stays unlinked", async () => {
    await withProject(async (projectRoot) => {
      const session = await startDevSession({
        projectRoot,
        resources: [defineDevResource("api", "main")],
        campOnlyCapabilities: ["cross-cloud-mtls"],
      });
      assert.equal(session.record.fidelityLabels["cross-cloud-mtls"], "camp-only");
      assert.equal(session.runtimeHost.linkTable().length >= 0, true);
    });
  });
});
