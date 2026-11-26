import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CiContext, CiRunnerResult } from "@cloudflare/ci";

import { verifyNativeConfig } from "./upstream-config.js";

type NativeRequest = Parameters<CiContext["runner"]>[0];
export class NativeContext {
	readonly requests: NativeRequest[] = [];
	roots = 0;
	chained = 0;
	terminations = 0;
	private child: ReturnType<typeof spawn> | undefined;
	constructor(
		readonly workspace: string,
		readonly trackedSource: ReadonlyMap<string, string> = new Map(),
	) {}
	readonly context: CiContext = {
		runner: async (request) => {
			this.roots++;
			return this.execute(request);
		},
	};
	readonly terminate = async (): Promise<void> => {
		this.terminations++;
		const child = this.child;
		if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
			return;
		const pid = child.pid;
		await new Promise<void>((resolvePromise) => {
			child.once("close", () => resolvePromise());
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				resolvePromise();
			}
		});
	};
	readonly verifyShutdown = async (): Promise<boolean> =>
		this.child === undefined ||
		this.child.exitCode !== null ||
		this.child.signalCode !== null;
	private async execute(request: NativeRequest): Promise<CiRunnerResult> {
		verifyNativeConfig(request);
		// The real SDK restores the prior snapshot, then overlays original tracked source.
		for (const [path, content] of this.trackedSource) {
			const target = resolve(this.workspace, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		this.requests.push(request);
		const result = await new Promise<{
			stdout: string;
			stderr: string;
			exitCode: number;
		}>((resolvePromise) => {
			const child = spawn("sh", ["-c", request.command], {
				cwd: resolve(this.workspace, request.cwd ?? "."),
				env: { PATH: process.env.PATH, ...request.env },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			this.child = child;
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.once("error", () =>
				resolvePromise({ stdout, stderr, exitCode: 70 }),
			);
			child.once("close", (code) =>
				resolvePromise({ stdout, stderr, exitCode: code ?? 70 }),
			);
		});
		this.child = undefined;
		return {
			...result,
			logs: { stdout: result.stdout, stderr: result.stderr },
			snapshot: { id: `snapshot-${this.requests.length}`, dir: "/workspace" },
			runner: async (next) => {
				this.chained++;
				return this.execute(next);
			},
		};
	}
}
