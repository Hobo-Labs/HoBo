import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: false,
    fileParallelism: true,
    pool: "threads",
    // Warm the shared wasmtime toolchain cache once per run so wasm tests on
    // throwaway HOBO_HOME dirs don't each re-download under parallel load.
    // Absolute: vitest resolves globalSetup against the project root (cwd),
    // which is a package dir when running filtered test commands.
    globalSetup: [
      // One root of throwaway HOBO_HOMEs for the run, removed when it ends
      // (test/setup/hobo-test-homes.ts; see the setup file below).
      fileURLToPath(new URL("./test/setup/hobo-test-homes.ts", import.meta.url)),
      fileURLToPath(
        new URL(
          "./packages/runtimes/runtime-wasm/test/wasmtime-global-setup.ts",
          import.meta.url,
        ),
      ),
    ],
    // Every test file gets a throwaway HOBO_HOME, so a test that omits an
    // explicit one cannot write into the developer's real ~/.hobo.
    setupFiles: [
    	fileURLToPath(new URL("./test/setup/isolate-hobo-home.ts", import.meta.url)),
    ],
    // What a bare root run must not collect.
    //
    // Vitest's include glob is repo-wide, and without this the root config
    // reached three kinds of file it cannot execute, so `pnpm run test:smoke`
    // reported ~40 failures on a clean tree and no real regression could be
    // seen through the noise. None of these are skipped — each runs under the
    // runner that owns it:
    //
    //  - `external/` is vendored third-party source. `external/ts-autocode` is
    //    a git submodule with its own repository and CI; `external/pixel-agents`
    //    is a vendored checkout. Both carry their own toolchains and test setup,
    //    and neither is this workspace's to gate.
    //  - `dist/` is build output. Every compiled `*.test.js` there is a second,
    //    staler copy of a source test that already runs, so collecting it doubles
    //    the suite and reports failures against code nobody edited.
    //  - Playwright specs drive a real browser through `@playwright/test`, whose
    //    `test.describe` has no meaning under vitest. They run from their own
    //    Playwright configuration.
    //
    // The bare root run is still not the repo-wide gate — packages carry their
    // own vitest configs with their own environments and setup files, and running
    // them all in one process with `isolate: false` makes independent suites
    // interfere. `pnpm run test:all` (turbo, one config per package) is that gate;
    // this config backs `test:file`/`test:name`, which target one file or one test.
    exclude: [
      "**/node_modules/**",
      "external/**",
      "**/dist/**",
      "**/e2e/**",
      "**/*.spec.ts",
    ],
    // typescript.js is CJS, but its source mentions module syntax, so Vitest
    // inlines it: Vite transforms the whole compiler per worker and warns that
    // the typescript.js.map it names is not shipped.
    server: {
      deps: { external: [/\/node_modules\/(?:.*\/)?typescript\/lib\/typescript\.js$/] },
    },
    testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
    hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
    coverage: { enabled: false },
    reporters: ["dot"],
  },
});
