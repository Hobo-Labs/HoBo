import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWasmtimeBinary, type WasmtimeBinary } from "@hobo/runtime-wasm";
import {
	COMPONENT_MEDIA_TYPE,
	type WasmComponentArtifact,
} from "./componentize.js";
import { validateRealWasmComponent } from "./real-componentize.js";

export interface WasmtimeSmokeOptions {
	readonly exportName: string;
	readonly resolveWasmtime?: () => Promise<WasmtimeBinary>;
	readonly timeoutMs?: number;
}

export interface WasmtimeSmokeReport {
	readonly command: string;
	readonly engine: string;
	readonly exitCode: 0;
	readonly stdout: string;
}

const MAX_GUEST_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_GUEST_RESOURCES = 1024;

export async function runWasmtimeSmoke(
	component: WasmComponentArtifact,
	options: WasmtimeSmokeOptions,
): Promise<WasmtimeSmokeReport> {
	if (component.mediaType !== COMPONENT_MEDIA_TYPE) {
		throw new Error(`componentize.invalid_media_type: ${component.mediaType}`);
	}
	validateRealWasmComponent(component.bytes);
	const digest = `sha256:${createHash("sha256").update(component.bytes).digest("hex")}`;
	if (digest !== component.digest) {
		throw new Error(
			`componentize.digest_mismatch: expected ${component.digest} got ${digest}`,
		);
	}

	const wasmtime = await (options.resolveWasmtime?.() ??
		ensureWasmtimeBinary());
	const directory = await mkdtemp(join(tmpdir(), "hobo-component-smoke-"));
	const componentPath = join(directory, "component.wasm");
	try {
		await writeFile(componentPath, component.bytes);
		const invocation = `${options.exportName}()`;
		const timeoutMs = options.timeoutMs ?? 30_000;
		const wasmLimits = [
			`timeout=${timeoutMs}ms`,
			`max-memory-size=${MAX_GUEST_MEMORY_BYTES}`,
			"max-instances=32",
			"max-memories=32",
			"max-tables=32",
		].join(",");
		const wasiLimits = [
			"http=y",
			"inherit-network=n",
			"tcp=n",
			"udp=n",
			"allow-ip-name-lookup=n",
			"inherit-env=n",
			"inherit-stdin=n",
			`max-resources=${MAX_GUEST_RESOURCES}`,
		].join(",");
		const args = [
			"run",
			"-W",
			wasmLimits,
			"-S",
			wasiLimits,
			"--invoke",
			invocation,
			componentPath,
		];
		const result = await runProcess(wasmtime.binPath, args, timeoutMs);
		if (result.exitCode !== 0) {
			throw new Error(
				`componentize.smoke_failed: wasmtime exited ${result.exitCode}: ${result.stderr.trim()}`,
			);
		}
		return {
			command: `wasmtime ${args.slice(0, -1).join(" ")} ${component.path}`,
			engine: `wasmtime@${wasmtime.version}`,
			exitCode: 0,
			stdout: result.stdout,
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function runProcess(
	binPath: string,
	args: readonly string[],
	timeoutMs: number,
) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(resolve, reject) => {
			const child = spawn(binPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (timedOut) {
					reject(
						new Error(`componentize.smoke_timeout: exceeded ${timeoutMs}ms`),
					);
					return;
				}
				resolve({ exitCode: code ?? -1, stdout, stderr });
			});
		},
	);
}
