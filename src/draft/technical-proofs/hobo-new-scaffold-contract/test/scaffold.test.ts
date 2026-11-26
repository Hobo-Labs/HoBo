import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  VALID_TEMPLATES,
  runHoboNew,
  scaffoldHoboProject,
  validateScaffoldProject
} from "../src/scaffold.js";

const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url)
);

// The generated stub's `npm test` is plain `node --test` over TypeScript
// sources with tsc-style `.js` specifiers, so the harness must hand the
// child a TypeScript loader explicitly; inheriting one from ambient
// NODE_OPTIONS made this pass only in tsx-wrapped environments.
const tsxLoaderUrl = new URL("../../../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

const expectedCreatedFiles = [
  ".gitignore",
  "app.test.ts",
  "app.ts",
  "hobo.bindle.json",
  "package.json",
  "src/_generated/hobo.d.ts",
  "src/_generated/index.ts",
  "tsconfig.json"
];

async function withScratch(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "hobo-new-scaffold-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertFile(root, relativePath) {
  const info = await stat(path.join(root, relativePath));
  assert.equal(info.isFile(), true, `${relativePath} should exist`);
}

describe("hobo new scaffold contract", () => {
  it("scaffolds an api project, emits JSON created-file metadata, and stays offline", async () => {
    await withScratch(async (cwd) => {
      let networkCalls = 0;
      const result = await runHoboNew(["snapshop", "-t", "api", "--json"], {
        cwd,
        network: {
          fetch() {
            networkCalls += 1;
            throw new Error("network fetch must not be called during hobo new");
          }
        }
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.equal(networkCalls, 0);

      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.command, "new");
      assert.equal(envelope.name, "snapshop");
      assert.equal(envelope.template, "api");
      assert.equal(envelope.offline, true);
      assert.deepEqual(envelope.nextSteps, ["cd snapshop", "hobo dev"]);
      assert.deepEqual(envelope.createdFiles, expectedCreatedFiles);

      const projectDir = path.join(cwd, "snapshop");
      for (const relativePath of expectedCreatedFiles) {
        await assertFile(projectDir, relativePath);
      }

      assert.match(await readFile(path.join(projectDir, ".gitignore"), "utf8"), /^\.hobo\/$/m);
      assert.match(await readFile(path.join(projectDir, "app.ts"), "utf8"), /export const api = hobo\.api/);
      assert.match(await readFile(path.join(projectDir, "src/_generated/index.ts"), "utf8"), /generated hobo new bindings seed/);

      const report = await validateScaffoldProject(projectDir);
      assert.equal(report.ok, true);
      assert.equal(report.template, "api");
      assert.equal(report.canRunHoboDev, true);
      assert.equal(report.typecheck.status, "pass");
      assert.equal(report.tests.status, "pass");
    });
  });

  it("creates all four templates as runnable SDK project stubs", { timeout: 60_000 }, async () => {
    await withScratch(async (cwd) => {
      assert.deepEqual(VALID_TEMPLATES, ["todo", "api", "agent", "fullstack"]);

      for (const template of VALID_TEMPLATES) {
        const { projectDir, createdFiles } = await scaffoldHoboProject({
          cwd,
          name: `sample-${template}`,
          template
        });

        assert.deepEqual(createdFiles, expectedCreatedFiles);

        const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
        assert.equal(packageJson.scripts.dev, "hobo dev");
        assert.equal(packageJson.scripts.test, "node --test");
        assert.equal(packageJson.scripts.typecheck, "tsc --noEmit");

        const report = await validateScaffoldProject(projectDir);
        assert.equal(report.ok, true);
        assert.equal(report.template, template);
        assert.equal(report.typecheck.status, "pass");
        assert.equal(report.tests.status, "pass");
        assertGeneratedProjectRuns(projectDir);
        assertGeneratedProjectTypechecks(projectDir);

        const app = await readFile(path.join(projectDir, "app.ts"), "utf8");
        assert.match(app, new RegExp(`template: "${template}"`));
      }
    });
  });

  it("prints exact next steps for human output", async () => {
    await withScratch(async (cwd) => {
      const result = await runHoboNew(["snapshop", "--template", "todo"], { cwd });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Created HoBo project snapshop/);
      assert.match(result.stdout, /cd snapshop\nhobo dev/);
    });
  });

  it("fails safely when the destination is populated and --force is absent", async () => {
    await withScratch(async (cwd) => {
      const projectDir = path.join(cwd, "snapshop");
      await mkdir(projectDir);
      await writeFile(path.join(projectDir, "README.md"), "existing human work\n");

      const result = await runHoboNew(["snapshop", "-t", "api"], { cwd });

      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /already exists and is not empty/);
      assert.match(result.stderr, /Use --force/);
      assert.equal(await readFile(path.join(projectDir, "README.md"), "utf8"), "existing human work\n");
      await assert.rejects(() => stat(path.join(projectDir, "package.json")), /ENOENT/);
    });
  });

  it("rejects invalid templates and unsafe project names without silently defaulting", async () => {
    await withScratch(async (cwd) => {
      const invalidTemplate = await runHoboNew(["snapshop", "-t", "worker"], { cwd });
      assert.equal(invalidTemplate.exitCode, 2);
      assert.equal(invalidTemplate.stdout, "");
      assert.match(invalidTemplate.stderr, /Unknown template "worker"/);
      assert.match(invalidTemplate.stderr, /todo, api, agent, fullstack/);

      for (const name of ["../snapshop", "snap/shop", "snap\\shop", "CON", "aux", "snap:shop", ""]) {
        const invalidName = await runHoboNew([name, "-t", "api"], { cwd });
        assert.equal(invalidName.exitCode, 2, `${name} should be rejected`);
        assert.equal(invalidName.stdout, "");
        assert.match(invalidName.stderr, /Invalid project name/);
      }
    });
  });

  it("can scaffold inside an existing git repo with --force without clobbering unrelated files", async () => {
    await withScratch(async (cwd) => {
      const projectDir = path.join(cwd, "snapshop");
      await mkdir(path.join(projectDir, ".git"), { recursive: true });
      await writeFile(path.join(projectDir, "README.md"), "do not touch\n");
      await writeFile(path.join(projectDir, ".gitignore"), "coverage/\n");
      await writeFile(path.join(projectDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      const result = await runHoboNew(["snapshop", "-t", "fullstack", "--force", "--json"], { cwd });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.equal(await readFile(path.join(projectDir, "README.md"), "utf8"), "do not touch\n");
      assert.equal(await readFile(path.join(projectDir, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
      assert.equal(await readFile(path.join(projectDir, ".gitignore"), "utf8"), "coverage/\n.hobo/\nnode_modules/\ndist/\n");

      const envelope = JSON.parse(result.stdout);
      assert.deepEqual(envelope.createdFiles, expectedCreatedFiles);
      await assertFile(projectDir, "package.json");
    });
  });
});

function assertGeneratedProjectRuns(projectDir) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd test"] : ["test"];
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, NODE_OPTIONS: `--import ${tsxLoaderUrl}` }
  });

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "generated npm test exited non-zero"
  );
}

function assertGeneratedProjectTypechecks(projectDir) {
  const result = spawnSync(process.execPath, [tscPath, "--noEmit", "--project", "tsconfig.json"], {
    cwd: projectDir,
    encoding: "utf8",
    shell: false
  });

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "generated TypeScript check exited non-zero"
  );
}
