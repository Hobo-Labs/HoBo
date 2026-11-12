import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const report = join(
	root,
	"scripts/ci/relay-deploy-secret-store-verify-report.mts",
);

describe("relay-deploy-secret-store-verify-report.mts", () => {
	it("prints check lines and exits with the verify status", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-report-"));
		const json = join(dir, "out.json");
		const err = join(dir, "err.txt");
		try {
			writeFileSync(
				json,
				`${JSON.stringify({
					ok: false,
					code: "HOBO_CI_SECRET_STORE_VERIFY_FAILED",
					message:
						"hobo-ci-writer (GitHub Actions OIDC): fail — infisical login-denied (HTTP 401) (oidc_sub=repo:Hobo-Labs/HoBo:ref:refs/heads/main, oidc_aud=https://github.com/Hobo-Labs)",
					data: {
						checks: [
							{
								identity: "hobo-ci-writer",
								method: "GitHub Actions OIDC",
								result: "fail",
								detail:
									"infisical login-denied (HTTP 401) (oidc_sub=repo:Hobo-Labs/HoBo:ref:refs/heads/main, oidc_aud=https://github.com/Hobo-Labs)",
							},
						],
					},
				})}\n`,
			);
			writeFileSync(err, "");
			const ran = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", report, json, err, "1"],
				{ encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
			);
			assert.equal(ran.status, 1);
			assert.match(
				ran.stdout,
				/login-denied.*oidc_sub=repo:Hobo-Labs\/HoBo:ref:refs\/heads\/main/u,
			);
			assert.match(ran.stdout, /::error title=Secret store verify::/u);
			assert.doesNotMatch(ran.stdout, /eyJ/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails loudly when stdout had no JSON envelope", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-report-"));
		const json = join(dir, "empty.json");
		const err = join(dir, "err.txt");
		try {
			writeFileSync(json, "");
			writeFileSync(err, "Cannot find module '@hobo/missing'\n");
			const ran = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", report, json, err, "1"],
				{ encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
			);
			assert.equal(ran.status, 1);
			assert.match(ran.stdout, /HOBO_CI_SECRET_STORE_VERIFY_NO_ENVELOPE/u);
			assert.match(ran.stdout, /stderr:/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
