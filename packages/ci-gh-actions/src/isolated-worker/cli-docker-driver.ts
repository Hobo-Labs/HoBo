import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type { DockerDriver, IsolatedContainerSpec } from "./docker-driver.js";

const exec = promisify(execFile);
const dockerImageInspection = z.object({
	Id: z.string().min(1),
	RepoTags: z.array(z.string()).default([]),
	Config: z
		.object({ Labels: z.record(z.string(), z.string()).nullable().default({}) })
		.default({ Labels: {} }),
});

/** `docker create` flags for the host engine socket (gid matches socket group inside container). */
export function dockerSocketMountCreateArgs(
	env: NodeJS.ProcessEnv,
	stat: (path: string) => { gid: number } = (path) => statSync(path),
): string[] {
	if (env.HOBO_CI_MOUNT_DOCKER_SOCKET === "0") return [];
	const socketPath = "/var/run/docker.sock";
	const gid = stat(socketPath).gid;
	return ["-v", `${socketPath}:${socketPath}`, "--group-add", String(gid)];
}

/** Operator-owned Docker engine on a free VM; not invoked from Vercel serverless. */
export function createCliDockerDriver(options: {
	env?: NodeJS.ProcessEnv;
	binary?: string;
}): DockerDriver {
	const docker = options.binary ?? "docker";
	const env = options.env ?? process.env;
	return {
		async inspectImage(image) {
			const { stdout } = await exec(docker, ["image", "inspect", image], {
				env,
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
			});
			const parsed = z
				.array(dockerImageInspection)
				.min(1)
				.parse(JSON.parse(stdout))[0];
			if (!parsed) throw new Error("docker returned no image inspection");
			return {
				id: parsed.Id,
				repoTags: parsed.RepoTags,
				labels: parsed.Config.Labels ?? {},
			};
		},
		async create(spec: IsolatedContainerSpec) {
			const args = [
				"create",
				"--rm",
				// `sleep infinity` as PID 1 ignores SIGTERM, so without an init every
				// `docker stop` waited out its full timeout while the slot stayed held.
				"--init",
				"--name",
				spec.name,
				"--network",
				"bridge",
				"--label",
				"hobo.ci/isolated=1",
				"--label",
				`hobo.ci/timeout-ms=${spec.timeoutMs}`,
			];
			if (spec.runAsUser) args.push("--user", spec.runAsUser);
			if (spec.memoryMb !== undefined) {
				if (!Number.isInteger(spec.memoryMb) || spec.memoryMb < 512)
					throw new Error("invalid container memory limit");
				args.push(
					"--memory",
					`${spec.memoryMb}m`,
					"--memory-swap",
					`${spec.memoryMb}m`,
				);
			}
			args.push(...dockerSocketMountCreateArgs(env));
			for (const volume of spec.volumes ?? []) {
				if (
					!/^[A-Za-z0-9][A-Za-z0-9_.-]*$|^\/[^:,]+$/.test(volume.source) ||
					!/^\/[^:,]+$/.test(volume.target)
				)
					throw new Error("invalid volume mount");
				args.push("-v", `${volume.source}:${volume.target}`);
			}
			for (const [key, value] of Object.entries(spec.env))
				args.push("-e", `${key}=${value}`);
			args.push(spec.image, ...spec.command);
			const { stdout } = await exec(docker, args, {
				env,
				timeout: 120_000,
				maxBuffer: 1024 * 1024,
			});
			const containerId = stdout.trim();
			if (!/^[a-f0-9]{64}$/.test(containerId))
				throw new Error("invalid container id");
			return { name: spec.name, containerId };
		},
		async start(_name, containerId) {
			await exec(docker, ["start", containerId], { env, timeout: 60_000 });
		},
		async exec(_name, containerId, argv) {
			try {
				await exec(docker, ["exec", containerId, ...argv], {
					env,
					timeout: 3_600_000,
					maxBuffer: 16 * 1024 * 1024,
				});
				return { exitCode: 0 };
			} catch (error) {
				let exitCode = 1;
				if (error instanceof Error) {
					const candidate = Object.getOwnPropertyDescriptor(
						error,
						"code",
					)?.value;
					if (Number.isInteger(candidate)) exitCode = candidate;
				}
				return { exitCode };
			}
		},
		async writeSecret(_name, containerId, path, content) {
			if (!/^\/[A-Za-z0-9_./-]+$/.test(path))
				throw new Error("invalid secret path");
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					docker,
					["exec", "-i", containerId, "sh", "-c", `umask 077 && cat > ${path}`],
					{ env, stdio: ["pipe", "ignore", "ignore"] },
				);
				const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
				child.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else reject(new Error("secret write failed"));
				});
				child.stdin.end(content);
			});
		},
		async execDetached(_name, containerId, argv) {
			try {
				await exec(docker, ["exec", "-d", containerId, ...argv], {
					env,
					timeout: 60_000,
					maxBuffer: 1024 * 1024,
				});
				return { exitCode: 0 };
			} catch {
				return { exitCode: 1 };
			}
		},
		async rename(containerId, name) {
			await exec(docker, ["rename", containerId, name], {
				env,
				timeout: 30_000,
			});
		},
		async stop(_name, containerId) {
			await exec(docker, ["stop", "-t", "30", containerId], {
				env,
				timeout: 120_000,
			});
		},
		async remove(_name, containerId) {
			await exec(docker, ["rm", "-f", containerId], { env, timeout: 120_000 });
		},
		async isRunning(_name, containerId) {
			const { stdout } = await exec(
				docker,
				[
					"inspect",
					"-f",
					"{{if .State.Running}}running{{else}}stopped{{end}}",
					containerId,
				],
				{ env, timeout: 30_000, maxBuffer: 4096 },
			);
			return stdout.trim() === "running";
		},
		async exists(_name, containerId, path) {
			if (!/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new Error("invalid path");
			try {
				await exec(docker, ["exec", containerId, "test", "-e", path], {
					env,
					timeout: 30_000,
					maxBuffer: 4096,
				});
				return true;
			} catch (error) {
				// `test` exits 1 for a missing path; docker's own failures are 125-127.
				if (
					error instanceof Error &&
					Object.getOwnPropertyDescriptor(error, "code")?.value === 1
				)
					return false;
				throw error;
			}
		},
	};
}
