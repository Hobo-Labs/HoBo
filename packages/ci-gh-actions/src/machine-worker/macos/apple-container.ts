/**
 * `--vm` on a Mac: each job in its own Linux VM through Apple's `container`
 * tool (ADR-0183).
 *
 * Apple's tool "create[s] and run[s] Linux containers as lightweight virtual
 * machines on your Mac"; it needs Apple silicon and macOS 26 or later
 * (https://github.com/apple/container, read 2026-11-17). Its commands are
 * `create`, `start`, `exec`, `list`, `stop`, `delete` and `system status`
 * (docs/command-reference.md in that repository, read 2026-11-17).
 *
 * The driver below speaks those commands behind the same `DockerDriver` the
 * Linux container path uses, so a VM job runs exactly as a container job
 * does: the box's start script downloads the pinned Linux arm64 runner,
 * checks its SHA-256 and runs it, the one-job configuration arrives over
 * stdin into a 0600 file, and the VM is stopped and deleted after the job.
 */
import { spawn } from "node:child_process";
import type {
	DockerDriver,
	IsolatedContainerSpec,
} from "../../isolated-worker/docker-driver.js";
import { containerExecutor, type JobExecutor } from "../executor.js";
import type { AppleContainerStatus } from "./platform.js";

// public-contract: the command Apple's container tool installs.
export const APPLE_CONTAINER_TOOL = "container";

/** What one run of a command gave back. */
export type ToolResult = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>;

/** Runs a command to its end; rejects only when it cannot start. */
export type ToolProcess = (
	command: string,
	args: readonly string[],
	options: Readonly<{ stdin?: string; signal?: AbortSignal }>,
) => Promise<ToolResult>;

const MAX_OUTPUT = 1024 * 1024;

/** `ToolProcess` over `child_process.spawn`, with no shell. */
export const nodeToolProcess: ToolProcess = (command, args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: ["pipe", "pipe", "pipe"],
			...(options.signal === undefined
				? undefined
				: { signal: options.signal }),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({ exitCode: code ?? 1, stdout, stderr }),
		);
		child.stdin.end(options.stdin ?? "");
	});

function notInstalled(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

/** Whether Apple's tool is installed and its services answer (`container system status`). */
export async function appleContainerStatus(
	process: ToolProcess,
): Promise<AppleContainerStatus> {
	try {
		const status = await process(
			APPLE_CONTAINER_TOOL,
			["system", "status"],
			{},
		);
		return status.exitCode === 0
			? { available: true }
			: {
					available: false,
					reason:
						"Apple's container tool is installed but its services are not running (run container system start).",
				};
	} catch (error) {
		return {
			available: false,
			reason:
				error instanceof Error && notInstalled(error)
					? "Apple's container tool is not installed (https://github.com/apple/container)."
					: "Apple's container tool could not be started.",
		};
	}
}

/**
 * A `DockerDriver` over Apple's tool: one VM per container. It does the parts
 * the machine's container executor uses, and nothing the box's warm pool does.
 */
export function appleContainerDriver(process: ToolProcess): DockerDriver {
	async function run(
		args: readonly string[],
		stdin?: string,
	): Promise<ToolResult> {
		return process(
			APPLE_CONTAINER_TOOL,
			args,
			stdin === undefined ? {} : { stdin },
		);
	}
	async function must(args: readonly string[], what: string): Promise<string> {
		const result = await run(args);
		if (result.exitCode !== 0)
			throw new Error(
				`container ${what} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
			);
		return result.stdout;
	}
	return {
		async create(spec: IsolatedContainerSpec) {
			const env = Object.entries(spec.env).flatMap(([name, value]) => [
				"--env",
				`${name}=${value}`,
			]);
			const stdout = await must(
				["create", "--name", spec.name, ...env, spec.image, ...spec.command],
				"create",
			);
			return { name: spec.name, containerId: stdout.trim() || spec.name };
		},
		async start(_name, containerId) {
			await must(["start", containerId], "start");
		},
		async exec(_name, containerId, argv) {
			const result = await run(["exec", containerId, ...argv]);
			return { exitCode: result.exitCode };
		},
		async execDetached(_name, containerId, argv) {
			const result = await run(["exec", "--detach", containerId, ...argv]);
			return { exitCode: result.exitCode };
		},
		async writeSecret(_name, containerId, path, content) {
			const result = await run(
				[
					"exec",
					"--interactive",
					containerId,
					"sh",
					"-c",
					'umask 077 && cat > "$1"',
					"sh",
					path,
				],
				content,
			);
			if (result.exitCode !== 0)
				throw new Error(
					"container exec could not write the runner's configuration",
				);
		},
		async exists(_name, containerId, path) {
			const result = await run(["exec", containerId, "test", "-e", path]);
			if (result.exitCode === 0) return true;
			if (result.exitCode === 1) return false;
			throw new Error(`container exec could not check ${path}`);
		},
		async readContainerFile(_name, containerId, path, maxBytes = 4096) {
			const result = await run([
				"exec",
				containerId,
				"head",
				"-c",
				String(maxBytes),
				path,
			]);
			return result.exitCode === 0 ? result.stdout : undefined;
		},
		async isRunning(_name, containerId) {
			// `list` shows running containers; `--quiet` prints only their ids.
			const ids = await must(["list", "--quiet"], "list");
			return ids
				.split("\n")
				.map((line) => line.trim())
				.includes(containerId);
		},
		async stop(_name, containerId) {
			await must(["stop", containerId], "stop");
		},
		async remove(_name, containerId) {
			await must(["delete", "--force", containerId], "delete");
		},
	};
}

/**
 * Run each job in its own Linux arm64 VM, made for it and deleted after it.
 * The VM gets the pinned Linux arm64 runner's download and the proxy
 * settings, and nothing else from this process's environment.
 */
export function appleContainerExecutor(
	options: Readonly<{
		process: ToolProcess;
		image: string;
		env: NodeJS.ProcessEnv;
		wait?: (ms: number, signal: AbortSignal) => Promise<void>;
	}>,
): JobExecutor {
	return containerExecutor({
		docker: appleContainerDriver(options.process),
		image: options.image,
		arch: "arm64",
		env: options.env,
		...(options.wait === undefined ? undefined : { wait: options.wait }),
	});
}
