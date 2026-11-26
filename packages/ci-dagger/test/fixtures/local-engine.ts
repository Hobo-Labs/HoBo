import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ContainerWithExecOpts } from "@dagger.io/dagger";
import { Directory } from "@dagger.io/dagger";
import { type PipelineStepResult, shellQuote } from "@hobo/ci";
import type {
	DaggerConnection,
	DaggerContainerPort,
} from "../../src/backend.js";

/**
 * Local consumer-contract fixture, not a Dagger engine or security sandbox.
 * It evaluates fluent SDK commands as real POSIX processes in an owned temp
 * workspace. The virtual /workspace mount maps only to that supplied directory.
 */
class LocalDirectory extends Directory {
	constructor(readonly workspace: string) {
		super();
	}
}
function inside(workspace: string, cwd: string): string {
	const virtual =
		cwd === "/workspace"
			? ""
			: cwd.startsWith("/workspace/")
				? cwd.slice("/workspace/".length)
				: undefined;
	if (virtual === undefined)
		throw new Error("fixture workdir is outside source mount");
	const path = resolve(workspace, virtual);
	const local = relative(workspace, path);
	if (local.startsWith("..") || isAbsolute(local))
		throw new Error("fixture workdir escapes source mount");
	return path;
}

export function createLocalDaggerConnection(
	directory: string,
	onResult?: (
		argv: readonly string[],
		output: Pick<PipelineStepResult, "exitCode" | "stdout" | "stderr">,
	) => void,
): DaggerConnection {
	const workspace = resolve(directory);
	const active = new Map<number, Promise<void>>();
	let closed = false;
	async function stop(): Promise<void> {
		for (const pid of active.keys()) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				/* group already stopped */
			}
		}
		const hard = setTimeout(() => {
			for (const pid of active.keys()) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					/* already stopped */
				}
			}
		}, 1000);
		try {
			await Promise.all(active.values());
		} finally {
			clearTimeout(hard);
		}
	}
	class LocalContainer implements DaggerContainerPort {
		readonly env: ReadonlyMap<string, string>;
		readonly cwd: string;
		readonly argv: readonly string[];
		private result:
			| Promise<{ exitCode: number; stdout: string; stderr: string }>
			| undefined;
		constructor(
			cwd = "/workspace",
			env: ReadonlyMap<string, string> = new Map(),
			argv: readonly string[] = [],
		) {
			this.cwd = cwd;
			this.env = env;
			this.argv = argv;
		}
		from(_image: string): LocalContainer {
			return new LocalContainer(this.cwd, this.env);
		}
		withDirectory(path: string, source: Directory): LocalContainer {
			if (
				path !== "/workspace" ||
				!(source instanceof LocalDirectory) ||
				source.workspace !== workspace
			)
				throw new Error("fixture source mount mismatch");
			return new LocalContainer(this.cwd, this.env);
		}
		directory(path: string): Directory {
			if (path !== "/workspace")
				throw new Error("fixture snapshot path mismatch");
			return new LocalDirectory(workspace);
		}
		withWorkdir(path: string): LocalContainer {
			inside(workspace, path);
			return new LocalContainer(path, this.env);
		}
		withEnvVariable(name: string, value: string): LocalContainer {
			const env = new Map(this.env);
			env.set(name, value);
			return new LocalContainer(this.cwd, env);
		}
		withExec(
			argv: string[],
			_options?: Pick<ContainerWithExecOpts, "expect">,
		): LocalContainer {
			return new LocalContainer(this.cwd, this.env, argv);
		}
		private execute(): Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}> {
			if (this.result) return this.result;
			if (closed)
				return Promise.reject(new Error("local Dagger fixture closed"));
			const argv = this.argv.map((value) =>
				value.startsWith("/workspace/")
					? join(workspace, value.slice("/workspace/".length))
					: value,
			);
			// The adapter's fixed artifact guard checks realpath against the virtual mount.
			// Substitute the owned host mount in that guard; argv/file contents stay literal.
			if (argv[0] === "sh" && argv[1] === "-c" && argv[3] === "hobo-artifact")
				argv[2] = String(argv[2]).replace(
					"/workspace/*",
					`${shellQuote(`${workspace}/`)}*`,
				);
			const command = argv.shift();
			if (!command) return Promise.reject(new Error("fixture command missing"));
			this.result = new Promise((resolveResult, reject) => {
				const env: NodeJS.ProcessEnv = {
					PATH: process.env.PATH,
					HOME: workspace,
					SHELL: "/bin/sh",
					LANG: "C.UTF-8",
				};
				for (const [name, value] of this.env) env[name] = value;
				const child = spawn(command, argv, {
					cwd: inside(workspace, this.cwd),
					env,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				let oversized = false;
				const limit = 2 * 1024 * 1024;
				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
					if (stdout.length > limit) {
						oversized = true;
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					}
				});
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
					if (stderr.length > limit) {
						oversized = true;
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					}
				});
				let finished: () => void = () => {};
				const exit = new Promise<void>((done) => {
					finished = done;
				});
				if (child.pid) active.set(child.pid, exit);
				const done = () => {
					if (child.pid) active.delete(child.pid);
					finished();
				};
				child.once("error", (error) => {
					done();
					reject(error);
				});
				child.once("close", (code, signal) => {
					done();
					if (oversized) reject(new Error("fixture output limit exceeded"));
					else {
						const result = {
							exitCode: code ?? (signal ? 143 : 1),
							stdout,
							stderr,
						};
						onResult?.(this.argv, result);
						resolveResult(result);
					}
				});
			});
			return this.result;
		}
		async exitCode(): Promise<number> {
			return (await this.execute()).exitCode;
		}
		async stdout(): Promise<string> {
			return (await this.execute()).stdout;
		}
		async stderr(): Promise<string> {
			return (await this.execute()).stderr;
		}
	}
	return {
		client: {
			container: () => new LocalContainer(),
			host: () => ({ directory: () => new LocalDirectory(workspace) }),
		},
		stop,
		async close() {
			closed = true;
			await stop();
		},
	};
}
