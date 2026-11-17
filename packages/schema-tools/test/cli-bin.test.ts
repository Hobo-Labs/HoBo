import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	FIXTURE_WORKSPACE,
	makeTempRepo,
	removeTempRepo,
} from "./support/temp-workspace.js";

const binary = fileURLToPath(
	new URL("../bin/hobo-codegen.mjs", import.meta.url),
);

it("runs the packaged executable and reports generated-file drift", async () => {
	const root = await makeTempRepo({ workspace: FIXTURE_WORKSPACE });
	try {
		const run = (...args: string[]) =>
			spawnSync(process.execPath, [binary, ...args], {
				cwd: root,
				encoding: "utf8",
				timeout: 60_000,
			});
		const generated = run("--json");
		expect(generated.status).toBe(0);
		expect(JSON.parse(generated.stdout).status).toBe("CLEAN");
		const file = join(root, "packages/widgets/src/_generated/widget_pb.ts");
		const altered = `${await readFile(file, "utf8")}\nexport const extra = true;\n`;
		await writeFile(file, altered);
		const checked = run("--check", "--json");
		expect(checked.status).toBe(1);
		const report = JSON.parse(checked.stdout);
		expect(report.status).toBe("DRIFT");
		expect(report.drift).toEqual([
			expect.objectContaining({
				path: expect.stringContaining("widget_pb.ts"),
				kind: "changed",
			}),
		]);
		expect(await readFile(file, "utf8")).toBe(altered);
	} finally {
		await removeTempRepo(root);
	}
}, 120_000);
