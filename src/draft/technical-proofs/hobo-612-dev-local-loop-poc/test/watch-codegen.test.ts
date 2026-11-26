import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { scaffoldHoboProject } from "../../hobo-new-scaffold-contract/src/scaffold.js";
import { writeFixtureProject } from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import { DevStateStore } from "../src/dev-state-store.js";
import { createWatchCodegen } from "../src/watch-codegen.js";
import { defineDevResource, startDevSession } from "../src/dev-session.js";

describe("watch codegen", () => {
  it("debounces concurrent saves to one codegen run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hobo-612-watch-"));
    try {
      const { projectDir } = await scaffoldHoboProject({ cwd: root, name: "snapshop", template: "api" });
      await writeFixtureProject(projectDir);

      const session = await startDevSession({
        projectRoot: projectDir,
        resources: [defineDevResource("api", "main")],
      });
      await session.watchCodegen.flush();
      const before = await readFile(path.join(projectDir, "src/_generated/bindings.d.ts"), "utf8");

      const zodPath = path.join(projectDir, ".hobo/sources/zod/resources.json");
      const zod = JSON.parse(await readFile(zodPath, "utf8"));
      zod.resources.ticket.fields.description = { type: "string" };
      await writeFile(zodPath, `${JSON.stringify(zod, null, 2)}\n`);

      session.watchCodegen.queueSourceChange(".hobo/sources/zod/resources.json");
      session.watchCodegen.queueSourceChange(".hobo/sources/zod/resources.json");
      const flushed = await session.watchCodegen.flush();
      const after = await readFile(path.join(projectDir, "src/_generated/bindings.d.ts"), "utf8");

      assert.equal(flushed.codegenRuns, 1);
      assert.notEqual(after, before);
      assert.match(after, /description: string;/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits dev.CodegenRan event on flush", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hobo-612-codegen-event-"));
    try {
      const { projectDir } = await scaffoldHoboProject({ cwd: root, name: "snapshop", template: "api" });
      await writeFixtureProject(projectDir);
      const store = new DevStateStore(projectDir);
      const watch = createWatchCodegen(store, projectDir);
      watch.queueSourceChange("src/app.ts");
      await watch.flush();
      assert.equal(store.events().some((event) => event.family === "dev.CodegenRan"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
