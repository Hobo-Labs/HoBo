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

function spawnCelld(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
	const child = spawn(CELLD_BIN, args, {
		env: {
			...process.env,
			AWS_ACCESS_KEY_ID: "hobo-live",
			AWS_SECRET_ACCESS_KEY: "hobo-live-secret",
			AWS_EC2_METADATA_DISABLED: "true",
			AWS_REGION: "us-east-1",
			CELLD_ESBUILD: ESBUILD,
			...extraEnv,
		},
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	cleanups.push(() => {
		child.kill("SIGTERM");
	});
	return { child, getOutput: () => output };
}

describe("celld live deploy and serve", () => {
	requireCelldBin();
	it("deploys a Worker+DO to the local CAS bucket and serves one increment", {
		timeout: 45_000,
	}, async () => {
		const s3 = await startS3CasServer();
		cleanups.push(() => s3.close());
		const project = join(tmpdir(), `celld-app-${Date.now()}`);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "wrangler.jsonc"),
			JSON.stringify({
				name: "counter",
				main: "index.js",
				compatibility_date: "2026-08-05",
				durable_objects: {
					bindings: [{ name: "COUNTER", class_name: "Counter" }],
				},
				migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
			}),
		);
		writeFileSync(
			join(project, "index.js"),
			`export class Counter {
  constructor(state) { this.state = state; }
  async fetch() {
    let count = (await this.state.storage.get("count")) ?? 0;
    count += 1;
    await this.state.storage.put("count", count);
    return new Response(JSON.stringify({ count }), {
      headers: { "content-type": "application/json" },
    });
  }
}
export default {
  async fetch(request, env) {
    const id = env.COUNTER.idFromName("room-42");
    return env.COUNTER.get(id).fetch(request);
  },
};
`,
		);

		const deploy = spawn(
			CELLD_BIN,
			[
				"deploy",
				project,
				"--bucket",
				"s3://hobo-live-cells",
				"--endpoint",
				s3.url,
			],
			{
				env: {
					...process.env,
					AWS_ACCESS_KEY_ID: "hobo-live",
					AWS_SECRET_ACCESS_KEY: "hobo-live-secret",
					AWS_EC2_METADATA_DISABLED: "true",
					AWS_REGION: "us-east-1",
					CELLD_ESBUILD: ESBUILD,
				},
			},
		);
		const deployOut = await new Promise<string>((resolve, reject) => {
			let out = "";
			const timer = setTimeout(() => {
				deploy.kill("SIGKILL");
				reject(new Error(`deploy timeout\n${out}`));
			}, 30_000);
			deploy.stdout.on("data", (c) => {
				out += String(c);
			});
			deploy.stderr.on("data", (c) => {
				out += String(c);
			});
			deploy.on("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) reject(new Error(`deploy ${code}\n${out}`));
				else resolve(out);
			});
		});
		expect(deployOut.toLowerCase()).toMatch(/deploy|ok|current/);

		const listen = "127.0.0.1:18080";
		const { child, getOutput } = spawnCelld([
			"--bucket",
			"s3://hobo-live-cells",
			"--endpoint",
			s3.url,
			"--listen",
			listen,
		]);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		let response: Response | undefined;
		let lastError = "";
		for (let attempt = 0; attempt < 10; attempt += 1) {
			try {
				response = await fetch(`http://${listen}/`);
				if (response.ok) break;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			await new Promise((resolve) => setTimeout(resolve, 400));
		}
		if (!response?.ok) {
			throw new Error(`celld serve failed: ${lastError}\n${getOutput()}`);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const body = (await response.json()) as { count?: number };
		expect(body.count).toBe(1);
		const second = await fetch(`http://${listen}/`);
		// SAFETY: assertion required at this I/O or test boundary.
		expect(((await second.json()) as { count: number }).count).toBe(2);
		child.kill("SIGTERM");
	});
});
