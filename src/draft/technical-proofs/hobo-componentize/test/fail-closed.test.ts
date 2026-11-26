import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { helloBindleSpec } from "./helpers.js";
import { PINNED_TOOLCHAIN, componentizeService } from "../src/index.js";

describe("componentize fail-closed guards", () => {
  it("rejects toolchain skew", () => {
    expect(() =>
      helloBindleSpec({
        toolchain: { ...PINNED_TOOLCHAIN, jco: "1.24.4" },
      }),
    ).toThrow(/componentize\.toolchain_skew: jco expected 1\.24\.3 got 1\.24\.4/);
  });

  it("rejects nondeterministic source", async () => {
    const root = await mkdtemp(join(tmpdir(), "hobo-componentize-bad-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "wit", "deps"), { recursive: true });
    await writeFile(
      join(root, "src", "service.ts"),
      'export const builtAt = Date.now();\nexport function health(): string { return "bad"; }\n',
      "utf8",
    );
    await writeFile(
      join(root, "wit", "deps", "hobo-sdk.wit"),
      "package hobo:sdk@0.1.0;\ninterface workflow {}\n",
      "utf8",
    );
    await writeFile(
      join(root, "wit", "hello-bindle.wit"),
      `package hobo:examples@0.1.0;\nworld hello-bindle {\n  import hobo:sdk/workflow@0.1.0;\n  export health: func() -> string;\n}\n`,
      "utf8",
    );

    try {
      await expect(
        componentizeService(
          helloBindleSpec({
            sourceRoot: root,
            witDir: join(root, "wit"),
          }),
        ),
      ).rejects.toThrow(/componentize\.nondeterministic_source: Date\.now/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
