import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startS3CasServer } from "./helpers/s3-cas.js";
import {
	celldBinPath,
	esbuildPath,
	requireCelldBin,
} from "./helpers/toolchain.js";

const CELLD_BIN = celldBinPath();
const ESBUILD = esbuildPath();

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(CELLD_BIN, args, {
			env: {
				...process.env,
				AWS_ACCESS_KEY_ID: "hobo-live",
				AWS_SECRET_ACCESS_KEY: "hobo-live-secret",
				AWS_EC2_METADATA_DISABLED: "true",
				AWS_REGION: "us-east-1",
				CELLD_ESBUILD: ESBUILD,
			},
		});
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timeout ${args.join(" ")}\n${out}`));
		}, 25_000);
		child.stdout.on("data", (c) => {
			out += String(c);
		});
		child.stderr.on("data", (c) => {
			out += String(c);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(`exit ${code}\n${out}`));
			else resolve(out);
		});
	});
}

describe("celld live wasm worker module", () => {
	requireCelldBin();
	it("serves a Worker that imports a compiled .wasm module, not a WIT component", {
		timeout: 45_000,
	}, async () => {
		const s3 = await startS3CasServer();
		cleanups.push(() => s3.close());
		const project = join(tmpdir(), `celld-wasm-${Date.now()}`);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "empty.wasm"),
			Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
		);
		writeFileSync(
			join(project, "wrangler.jsonc"),
			JSON.stringify({
				name: "wasm-probe",
				main: "index.js",
				compatibility_date: "2026-08-05",
			}),
		);
		writeFileSync(
			join(project, "index.js"),
			`import wasm from "./empty.wasm";
export default {
  async fetch() {
    const kind = wasm instanceof WebAssembly.Module ? "worker-module" : typeof wasm;
    return new Response(kind);
  }
};
`,
		);
		await run([
			"deploy",
			project,
			"--bucket",
			"s3://hobo-live-wasm",
			"--endpoint",
			s3.url,
		]);
		const listen = "127.0.0.1:18081";
		const child = spawn(
			CELLD_BIN,
			[
				"--bucket",
				"s3://hobo-live-wasm",
				"--endpoint",
				s3.url,
				"--listen",
				listen,
			],
			{
				env: {
					...process.env,
					AWS_ACCESS_KEY_ID: "hobo-live",
					AWS_SECRET_ACCESS_KEY: "hobo-live-secret",
					AWS_EC2_METADATA_DISABLED: "true",
					AWS_REGION: "us-east-1",
				},
			},
		);
		cleanups.push(() => {
			child.kill("SIGTERM");
		});
		let text = "";
		let lastError = "";
		for (let attempt = 0; attempt < 12; attempt += 1) {
			try {
				const response = await fetch(`http://${listen}/`);
				if (response.ok) {
					text = await response.text();
					break;
				}
				lastError = `HTTP ${response.status}`;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			await new Promise((resolve) => setTimeout(resolve, 400));
		}
		if (text !== "worker-module") {
			throw new Error(
				`celld wasm worker did not serve worker-module: ${lastError || text}`,
			);
		}
		expect(text).not.toMatch(/component/i);
	});
});
