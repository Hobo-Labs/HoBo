import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import type { DockerDriver, IsolatedContainerSpec } from "./docker-driver.js";

const exec = promisify(execFile);

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
		async create(spec: IsolatedContainerSpec) {
			const args = [
				"create",
				"--rm",
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
	};
}
