import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { bundleCliSdk, prepareCliSdkManifest } from "../ci/bundle-cli-sdk.mts";

const root = join(import.meta.dirname, "../..");
const readJson = async (path: string) =>
	JSON.parse(await readFile(path, "utf8"));

it("rejects changed CLI dependencies and training contracts", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-cli-guard-"));
	try {
		const manifest = await readJson(join(root, "packages/cli/package.json"));
		const prepared = prepareCliSdkManifest(manifest, root);
		assert.equal(prepared.dependencies?.["@hobo/core"], "workspace:*");
		assert.equal(
			prepared.dependencies?.["typescript-patterns"],
			"npm:typescript@6.0.3",
		);
		assert.equal(prepared.dependencies?.["@hobo/cd"], undefined);
		assert.throws(
			() =>
				prepareCliSdkManifest(
					{
						...manifest,
						dependencies: { ...manifest.dependencies, mystery: "1.0.0" },
					},
					root,
				),
			/unexpected direct dependencies/,
		);
		assert.throws(
			() =>
				prepareCliSdkManifest(
					{
						...manifest,
						exports: {
							...manifest.exports,
							"./extra": { default: "./dist/extra.js" },
						},
					},
					root,
				),
			/unsupported export map/,
		);
		await mkdir(join(temp, "packages/cli/dist/codegen"), { recursive: true });
		await mkdir(join(temp, "external/ts-autocode/packages/training/dist"), {
			recursive: true,
		});
		const training = join(temp, "external/ts-autocode/packages/training");
		await cp(
			join(root, "external/ts-autocode/packages/training/package.json"),
			join(training, "package.json"),
		);
		await writeFile(
			join(training, "dist/index.js"),
			'export { discoverInSource } from "./not-source.js";\n',
		);
		await assert.rejects(
			bundleCliSdk(join(temp, "out"), temp),
			/training source contract changed/,
		);
		await writeFile(
			join(training, "dist/index.js"),
			'export { discoverInSource } from "./source.js";\n',
		);
		await writeFile(
			join(temp, "packages/cli/dist/codegen/trainables.js"),
			'export async function scan() { return (await import("ts-autocode-training")).other; }\n',
		);
		await assert.rejects(
			bundleCliSdk(join(temp, "out"), temp),
			/training importer contract changed/,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
