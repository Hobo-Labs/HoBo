import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { evaluateCelldBucketCas } from "../src/index.js";
import { startS3CasServer } from "./helpers/s3-cas.js";
import {
	celldBinPath,
	esbuildPath,
	requireCelldBin,
} from "./helpers/toolchain.js";

const CELLD_BIN = celldBinPath();
const ESBUILD = esbuildPath();

async function runCelld(
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
	timeoutMs = 20_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(CELLD_BIN, [...args, "--listen", "127.0.0.1:0"], {
			env: {
				...process.env,
				AWS_ACCESS_KEY_ID: "hobo-live",
				AWS_SECRET_ACCESS_KEY: "hobo-live-secret",
				AWS_EC2_METADATA_DISABLED: "true",
				AWS_REGION: "us-east-1",
				...extraEnv,
			},
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(`celld timeout: ${args.join(" ")}\n${stdout}\n${stderr}`),
			);
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});
}

describe("celld live baremetal", () => {
	requireCelldBin();
	it("runs the pinned linux binary", () => {
		const result = spawnSync(CELLD_BIN, ["--version"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/celld 0\.2\.1/);
	});

	it("fails closed when the bucket endpoint is dead", {
		timeout: 25_000,
	}, async () => {
		const result = await runCelld([
			"diagnose",
			"--bucket",
			"s3://hobo-live-cells",
			"--endpoint",
			"http://127.0.0.1:9",
			"--read-only",
		]);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toMatch(/bucket unavailable/i);
	});

	it("diagnoses a local CAS bucket and proves conditional writes", async () => {
		const s3 = await startS3CasServer();
		try {
			const listed = await runCelld([
				"diagnose",
				"--bucket",
				"s3://hobo-live-cells",
				"--endpoint",
				s3.url,
				"--read-only",
			]);
			expect(listed.status, listed.stderr || listed.stdout).toBe(0);

			const probed = await runCelld(
				["diagnose", "--bucket", "s3://hobo-live-cells", "--endpoint", s3.url],
				{ CELLD_STORAGE_PROBE: "1" },
			);
			expect(probed.status, probed.stderr || probed.stdout).toBe(0);
			expect(
				evaluateCelldBucketCas({
					conditionalWrite: true,
					readAfterWrite: true,
				}),
			).toBe(true);
		} finally {
			await s3.close();
		}
	});

	it("refuses filesystem buckets even when a binary is present", async () => {
		const result = await runCelld(["--bucket", "file:///tmp/cells"]);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toMatch(
			/bucket|s3:\/\/|gs:\/\/|file:|scheme|invalid/i,
		);
	});

	it("records whether esbuild is available for Worker deploy", () => {
		expect(existsSync(ESBUILD)).toBe(true);
	});
});
