import { spawn } from "node:child_process";
import type {
	DockerDriver,
	IsolatedContainerSpec,
} from "../../isolated-worker/docker-driver.js";
import { containerExecutor, type JobExecutor } from "../executor.js";
import type { AppleContainerStatus } from "./platform.js";

export const APPLE_CONTAINER_TOOL = "container";

export type ToolResult = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>;

export type ToolProcess = (
	command: string,
	args: readonly string[],
	options: Readonly<{ stdin?: string; signal?: AbortSignal }>,
) => Promise<ToolResult>;

const MAX_OUTPUT = 1024 * 1024;

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
