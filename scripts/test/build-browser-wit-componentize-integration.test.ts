import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const worker = path.join(
	import.meta.dirname,
	"browser-wit-componentize-integration-worker.mts",
);

function runWorker(mode: "absolute" | "relative-wit"): void {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", worker, mode],
		{
			cwd: path.join(import.meta.dirname, "..", ".."),
			encoding: "utf8",
			env: process.env,
		},
	);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	if (mode === "absolute") {
		const bytes = Number.parseInt(result.stdout.trim(), 10);
		expect(bytes).toBeGreaterThan(0);
	}
}

describe("browser WIT componentize integration (componentize-js host witPath)", () => {
	it(
		"absolute sandbox wit and source paths componentize (HoBo release path)",
		() => runWorker("absolute"),
		180_000,
	);

	it(
		"relative wit without cwd mutation fails closed (regression of #2999)",
		() => runWorker("relative-wit"),
		180_000,
	);
});
