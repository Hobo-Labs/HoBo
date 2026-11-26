import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const worker = path.join(
	import.meta.dirname,
	"browser-wit-production-build-worker.mts",
);
const waspDist = path.join(repoRoot, "packages/wasp/dist/index.js");
const catalogDepsReady = existsSync(waspDist);

describe("browser WIT production build integration", () => {
	const runIntegration = catalogDepsReady ? it : it.skip;

	runIntegration(
		"buildBrowserWitRuntime on production env (release entry)",
		async () => {
			const xdg = await mkdtemp(path.join(tmpdir(), "browser-wit-xdg-"));
			const result = spawnSync(process.execPath, ["--import", "tsx", worker], {
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 300_000,
				maxBuffer: 10 * 1024 * 1024,
				env: {
					...process.env,
					HOBO_RELEASE_CHECKOUT_REF: "HEAD",
					XDG_CACHE_HOME: xdg,
				},
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
		},
		330_000,
	);
});
