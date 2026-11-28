import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function runPublishedAdapterFixture(
	fixture: URL,
	entry: string,
): string {
	const packageDir = fileURLToPath(new URL("../", import.meta.url));
	const directory = mkdtempSync(join(packageDir, ".test-dist-"));
	try {
		const compiler = createRequire(import.meta.url).resolve(
			"typescript/bin/tsc",
		);
		execFileSync(
			process.execPath,
			[
				compiler,
				"-p",
				join(packageDir, "tsconfig.json"),
				"--outDir",
				directory,
			],
			{
				timeout: 120_000,
			},
		);
		return execFileSync(
			process.execPath,
			[fileURLToPath(fixture), pathToFileURL(join(directory, entry)).href],
			{
				encoding: "utf8",
				timeout: 15_000,
			},
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
