import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KEPT_LOCATOR } from "../../packages/provider-redaction/dist/provider-redaction.js";
import { assertRevealsNoMore } from "../../packages/redaction-test-harness/dist/redaction-differential.js";
import { assertPatternSweepLinear } from "../../packages/redaction-test-harness/dist/linear-sweep.js";
import {
	RELAY_DEPLOY_BEARER_PATTERN,
	redactRelayDeployText,
} from "../ci/relay-deploy-redaction.mts";
import { retiredRelayDeployRedactNoise } from "./fixtures/relay-deploy-retired-redact-noise.js";

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
						"hobo-ci-deploy (GitHub Actions OIDC): fail — infisical login-denied (HTTP 401) (oidc_sub=repo:Hobo-Labs/HoBo:ref:refs/heads/main, oidc_aud=https://github.com/Hobo-Labs)",
					data: {
						checks: [
							{
								identity: "hobo-ci-deploy",
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

	it("redacts JWT-shaped text in check details", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-report-"));
		const json = join(dir, "out.json");
		const err = join(dir, "err.txt");
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
		try {
			writeFileSync(
				json,
				`${JSON.stringify({
					ok: false,
					code: "HOBO_CI_SECRET_STORE_VERIFY_FAILED",
					message: "fail",
					data: {
						checks: [
							{
								identity: "hobo-ci-deploy",
								method: "GitHub Actions OIDC",
								result: "fail",
								detail: `leaked ${jwt}`,
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
			assert.match(ran.stdout, /\[redacted\]/u);
			assert.doesNotMatch(ran.stdout, /eyJhbGciOiJIUzI1NiJ9/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails when stdout had no JSON envelope even if verify exited 0", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-report-"));
		const json = join(dir, "empty.json");
		const err = join(dir, "err.txt");
		try {
			writeFileSync(json, "");
			writeFileSync(err, "");
			const ran = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", report, json, err, "0"],
				{ encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
			);
			assert.equal(ran.status, 1);
			assert.match(ran.stdout, /HOBO_CI_SECRET_STORE_VERIFY_NO_ENVELOPE/u);
			assert.match(ran.stdout, /::error title=Secret store verify::/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hides every credential the retired redactNoise rule hid", () => {
		const hidden = assertRevealsNoMore(
			retiredRelayDeployRedactNoise,
			(text) => redactRelayDeployText(text, 1_000_000),
			{ count: 5_000, kept: KEPT_LOCATOR },
		);
		assert.ok(hidden > 500);
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
		for (const text of [
			"Bearer SECRetKpR9wZ",
			"bearer\tSECRetKpR9wZ",
			`Authorization: Bearer SECRetKpR9wZ ${jwt}`,
		])
			assert.equal(
				redactRelayDeployText(text, 4096).includes("SECRetKpR9wZ"),
				false,
			);
	});

	it("redacts an untrusted envelope code in the summary and annotation", () => {
		const dir = mkdtempSync(join(tmpdir(), "verify-report-"));
		const json = join(dir, "out.json");
		try {
			writeFileSync(
				json,
				JSON.stringify({
					ok: false,
					code: "HOBO_TEST Bearer SECRetKpR9wZ",
					message: "login-denied",
				}),
			);
			const ran = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", report, json, "", "1"],
				{ encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
			);
			assert.equal(ran.status, 1);
			assert.match(ran.stdout, /\[redacted\]/iu);
			assert.doesNotMatch(ran.stdout, /SECRetKpR9wZ/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the relay bearer coverage linear on its adversarial sweep", () => {
		assertPatternSweepLinear(RELAY_DEPLOY_BEARER_PATTERN);
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
