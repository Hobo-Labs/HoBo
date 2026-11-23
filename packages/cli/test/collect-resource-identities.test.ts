import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadProjectCollectionTarget,
	RESOURCE_IDENTITY_FILE,
} from "../src/cloud/loader.js";
import { createCollectCommand } from "../src/commands/collect.js";
import { createHoboCli } from "../src/index.js";

const projects: string[] = [];

afterEach(async () => {
	await Promise.all(
		projects.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function project(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-resource-ids-"));
	projects.push(dir);
	await mkdir(path.join(dir, "src"));
	await writeFile(path.join(dir, "hobo.bindle.json"), "{}\n");
	const bindles = new URL("../../bindles/dist/index.js", import.meta.url).href;
	await writeFile(
		path.join(dir, "src", "bindle.mjs"),
		`import { bindle } from ${JSON.stringify(bindles)};\nexport default bindle("shop", (builder) => { const cache = builder.kv(); return { cache, api: builder.api().dependsOn(cache) }; });\n`,
	);
	return dir;
}

describe("collecting resource identities", () => {
	it("creates a reviewed ledger and uses it on subsequent collection", async () => {
		const cwd = await project();
		const cli = createHoboCli({
			commands: {
				collect: createCollectCommand({
					resolveTarget: loadProjectCollectionTarget,
				}),
			},
		});
		const legacy = await cli.run(["collect", "--json"], { cwd });
		expect(JSON.parse(legacy.stdout).data.resources).toEqual(["api", "cache"]);

		const initialized = await cli.run(
			["collect", "--init-resource-ids", "--json"],
			{ cwd },
		);
		expect(initialized.exitCode).toBe(0);
		const ledgerPath = path.join(cwd, RESOURCE_IDENTITY_FILE);
		const ledger = await readFile(ledgerPath, "utf8");
		expect(JSON.parse(ledger).entries).toHaveLength(2);

		const generated = await cli.run(["collect", "--json"], { cwd });
		expect(generated.exitCode).toBe(0);
		expect(JSON.parse(generated.stdout).data.resources).toEqual([
			"res_api_0001",
			"res_kv_0001",
		]);
		const duplicate = await cli.run(
			["collect", "--init-resource-ids", "--json"],
			{ cwd },
		);
		expect(JSON.parse(duplicate.stdout).code).toBe(
			"HOBO_RESOURCE_IDENTITY_EXISTS",
		);
		expect(await readFile(ledgerPath, "utf8")).toBe(ledger);
	});

	it("does not create a ledger in check mode", async () => {
		const cwd = await project();
		const cli = createHoboCli({
			commands: {
				collect: createCollectCommand({
					resolveTarget: loadProjectCollectionTarget,
				}),
			},
		});
		const result = await cli.run(
			["collect", "--check", "--init-resource-ids", "--json"],
			{ cwd },
		);
		expect(JSON.parse(result.stdout).code).toBe(
			"HOBO_RESOURCE_IDENTITY_UNAVAILABLE",
		);
		await expect(
			readFile(path.join(cwd, RESOURCE_IDENTITY_FILE)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
