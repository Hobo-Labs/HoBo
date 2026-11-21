import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("build-agent-plugin CI posture", { timeout: 300_000 }, () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("refuses a bundle when CI is active without GITHUB_ACTIONS", () => {
		const build = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/build-agent-plugin.mts"],
			{
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 300_000,
				env: {
					...process.env,
					CI: "1",
					GITHUB_ACTIONS: "",
					TF_BUILD: "",
				},
			},
		);
		expect(build.status).not.toBe(0);
		const combined = `${build.stdout}\n${build.stderr}`;
		expect(combined).toMatch(
			/refuse to ship a bundle without attestation|GITHUB_ACTIONS/u,
		);
	});

	it("does not request or persist an OIDC bearer token", () => {
		const source = readFileSync(
			path.join(repoRoot, "scripts/build-agent-plugin.mts"),
			"utf8",
		);
		expect(source).not.toContain("ACTIONS_ID_TOKEN_REQUEST");
		expect(source).not.toContain("oidcToken");
		expect(source).not.toContain("requestGithubOidcToken");
	});
});
