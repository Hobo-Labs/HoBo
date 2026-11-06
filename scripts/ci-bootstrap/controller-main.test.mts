import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./controller-main.mts", import.meta.url));
const local = generateKeyPairSync("rsa", {
	modulusLength: 3072,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
test("actual controller prepare accepts only pinned workflow identity and emits public artifact", () => {
	const temp = mkdtempSync(join(tmpdir(), "hobo-cli-temp-")),
		workspace = mkdtempSync(join(tmpdir(), "hobo-cli-work-"));
	try {
		const env = {
			PATH: process.env.PATH,
			RUNNER_TEMP: temp,
			GITHUB_WORKSPACE: workspace,
			GITHUB_RUN_ID: "123",
			GITHUB_RUN_ATTEMPT: "2",
			GITHUB_SHA: "a".repeat(40),
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REF: "refs/heads/ops/ci-runner-bootstrap-5636332",
			GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
			GITHUB_REPOSITORY_ID: "1274791462",
			HOBO_BOOTSTRAP_SIGNING_PUBLIC_KEY: Buffer.from(local.publicKey).toString(
				"base64",
			),
		};
		let r = spawnSync(
			process.execPath,
			["--experimental-strip-types", src, "prepare"],
			{ env, encoding: "utf8", timeout: 10000 },
		);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "");
		const artifact = JSON.parse(
			readFileSync(
				join(workspace, ".hobo-bootstrap-public/controller.json"),
				"utf8",
			),
		);
		assert.equal(artifact.runId, 123);
		assert.equal(artifact.runAttempt, 2);
		assert(!JSON.stringify(artifact).includes("PRIVATE KEY"));
		assert.equal(
			statSync(join(temp, "hobo-controller-123-2/controller-private.pem"))
				.mode & 0o077,
			0,
		);
		const rejectedTemp = join(temp, "rejected");
		const rejectedWorkspace = join(workspace, "rejected");
		r = spawnSync(
			process.execPath,
			["--experimental-strip-types", src, "prepare"],
			{
				env: {
					...env,
					RUNNER_TEMP: rejectedTemp,
					GITHUB_WORKSPACE: rejectedWorkspace,
					GITHUB_EVENT_NAME: "pull_request",
				},
				encoding: "utf8",
				timeout: 10000,
			},
		);
		assert.equal(r.status, 1);
		assert.equal(existsSync(rejectedTemp), false);
		assert.equal(existsSync(rejectedWorkspace), false);
		assert(!r.stderr.includes("PRIVATE KEY"));
	} finally {
		rmSync(temp, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
});
