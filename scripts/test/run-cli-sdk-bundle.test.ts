import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { resetCliSdkDist, runCliSdkBundle } from "../ci/run-cli-sdk-bundle.mts";

const root = join(import.meta.dirname, "../..");

it("refuses an unreviewed declaration package license before producing a bundle", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-cli-declaration-license-"));
	try {
		for (const name of ["cli", "patterns", "backend-routing"]) {
			await mkdir(join(temp, "packages", name), { recursive: true });
			await cp(
				join(root, "packages", name, "package.json"),
				join(temp, "packages", name, "package.json"),
			);
		}
		await mkdir(join(temp, "external/ts-autocode/packages/training"), {
			recursive: true,
		});
		await cp(
			join(root, "external/ts-autocode/packages/training/package.json"),
			join(temp, "external/ts-autocode/packages/training/package.json"),
		);
		await writeFile(
			join(temp, "packages/backend-routing/LICENSE"),
			"unreviewed license\n",
		);
		await assert.rejects(
			runCliSdkBundle(temp, join(temp, "out")),
			/declaration license changed/,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

it("removes copied stale output without touching the workspace package", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-cli-dist-reset-"));
	const source = join(temp, "packages/cli");
	const staging = join(temp, "staging");
	try {
		await mkdir(join(source, "dist"), { recursive: true });
		await mkdir(join(staging, "dist"), { recursive: true });
		await writeFile(join(source, "dist", "source.js"), "source");
		await writeFile(join(staging, "dist", "stale.js"), "stale");
		resetCliSdkDist(temp, staging);
		assert.equal(existsSync(join(staging, "dist")), false);
		assert.equal(existsSync(join(source, "dist", "source.js")), true);
		assert.throws(
			() => resetCliSdkDist(temp, source),
			/must not be the source package/,
		);
		assert.equal(existsSync(join(source, "dist", "source.js")), true);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
