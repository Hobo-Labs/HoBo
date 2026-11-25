import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runBuild, writeBuildFixtureProject } from "../src/build/run-build.js";
import { runCodegen } from "../src/codegen/run-codegen.js";

it("product real-build policy refuses synthetic success when the real toolchain is unavailable", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-product-build-"));
	try {
		await writeBuildFixtureProject(root, {
			services: [
				{
					name: "hello-bindle",
					language: "ts",
					runtime: "wasm",
					sourceRoot: "services/hello-bindle",
					entrypoint: "services/hello-bindle/src/service.ts",
				},
			],
		});
		await runCodegen({ projectRoot: root, check: false });
		await expect(
			runBuild({
				projectRoot: root,
				targetRuntime: "auto",
				sourceDateEpoch: "2026-01-01T00:00:00.000Z",
				requireRealComponentize: true,
				realComponentizeFactory: async () => ({
					available: false,
					async componentize() {
						throw new Error("unavailable");
					},
				}),
			}),
		).rejects.toMatchObject({ code: "HOBO_BUILD_COMPONENTIZE_TOOLCHAIN" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
