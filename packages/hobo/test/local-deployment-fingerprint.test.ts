import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fingerprintLocalDeployment } from "../src/local-deployment-fingerprint.js";

it("fingerprints authored code and raw packaged artifacts while ignoring private state and temporary files", async () => {
	const project = await mkdtemp(join(tmpdir(), "hobo-deploy-inputs-"));
	const home = join(project, "configured-home");
	try {
		await mkdir(join(project, "src"));
		await writeFile(join(project, "src/app.ts"), "export const version = 1;");
		await expect(fingerprintLocalDeployment(project, project)).rejects.toThrow(
			"HOBO_HOME must be separate",
		);
		const initial = await fingerprintLocalDeployment(project, home);
		for (const path of [
			".git/index",
			"node_modules/dependency/index.js",
			".hobo/local-deployment.json",
			".hobo/local-deployment-events/events.sqlite",
			"configured-home/yard.json",
			"debug.log",
			"src/app.ts.swp",
			"editor.tmp",
			".hobo-codegen-stage/generated.ts",
		]) {
			const file = join(project, path);
			await mkdir(join(file, ".."), { recursive: true });
			await writeFile(file, "private or temporary state");
		}
		expect(await fingerprintLocalDeployment(project, home)).toBe(initial);
		await writeFile(join(project, "src/app.ts"), "export const version = 2;");
		const changedSource = await fingerprintLocalDeployment(project, home);
		expect(changedSource).not.toBe(initial);
		await mkdir(join(project, ".hobo/build/assets"), { recursive: true });
		const asset = join(project, ".hobo/build/assets/binary.tmp");
		await writeFile(asset, new Uint8Array([0, 255, 128, 1]));
		const packaged = await fingerprintLocalDeployment(project, home);
		expect(packaged).not.toBe(changedSource);
		await writeFile(asset, new Uint8Array([0, 254, 128, 1]));
		expect(await fingerprintLocalDeployment(project, home)).not.toBe(packaged);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
