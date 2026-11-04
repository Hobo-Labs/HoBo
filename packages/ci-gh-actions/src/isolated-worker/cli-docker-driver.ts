import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type {
	ContainerResourceWeights,
	DockerDriver,
	IsolatedContainerSpec,
} from "./docker-driver.js";
import type { WorkerImage } from "./image-gc.js";
import type { WorkerStorageDockerDriver } from "./storage-admission.js";

const exec = promisify(execFile);
const dockerImage = z.object({
	ID: z.string().min(1),
	Repository: z.string(),
	Tag: z.string(),
	CreatedAt: z.string(),
});
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

export function builderPruneArgs(keepStorage: string): string[] {
	if (!/^\d+(?:\.\d+)?[KMGT]B$/u.test(keepStorage))
		throw new Error("invalid builder keep-storage");
	return ["builder", "prune", "--force", "--keep-storage", keepStorage];
}

function containerResourceArgs(
	weights: Readonly<{ cpuShares?: number; blkioWeight?: number }>,
	includeBlkio: boolean,
): string[] {
	const args: string[] = [];
	if (weights.cpuShares !== undefined) {
		if (
			!Number.isInteger(weights.cpuShares) ||
			weights.cpuShares < 2 ||
			weights.cpuShares > 262_144
		)
			throw new Error("invalid container CPU shares");
		args.push("--cpu-shares", String(weights.cpuShares));
	}
	if (includeBlkio && weights.blkioWeight !== undefined) {
		if (
			!Number.isInteger(weights.blkioWeight) ||
			weights.blkioWeight < 10 ||
			weights.blkioWeight > 1_000
		)
			throw new Error("invalid container block IO weight");
		args.push("--blkio-weight", String(weights.blkioWeight));
	}
	return args;
}

function blkioWeightUnsupported(message: string): boolean {
	return /blkio|block i\/o|io\.weight|unknown flag|not supported/iu.test(
		message,
	);
}

/** Operator-owned Docker engine on a free VM; not invoked from Vercel serverless. */
export function createCliDockerDriver(options: {
	env?: NodeJS.ProcessEnv;
	binary?: string;
	log?: (
		event: "hobo_ci_blkio_weight_unsupported",
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}): DockerDriver & WorkerStorageDockerDriver {
	const docker = options.binary ?? "docker";
	const env = options.env ?? process.env;
	let blkioWeightSupported = true;
	let blkioFailureLogged = false;
	const withBlkioFallback = async <T>(
		weights: Readonly<{ cpuShares?: number; blkioWeight?: number }>,
		operation: (includeBlkio: boolean) => Promise<T>,
	): Promise<T> => {
		try {
			return await operation(blkioWeightSupported);
		} catch (error) {
			if (
				weights.blkioWeight === undefined ||
				!blkioWeightSupported ||
				!blkioWeightUnsupported(error instanceof Error ? error.message : "")
			)
				throw error;
			blkioWeightSupported = false;
			if (!blkioFailureLogged) {
				blkioFailureLogged = true;
				const fields = {
					message: error instanceof Error ? error.message : "unknown",
				};
				if (options.log)
					options.log("hobo_ci_blkio_weight_unsupported", fields);
				else
					console.error(
						JSON.stringify({
							event: "hobo_ci_blkio_weight_unsupported",
							...fields,
						}),
					);
			}
			return operation(false);
		}
	};
	return {
		async dataRoot() {
			const { stdout } = await exec(
				docker,
				["info", "--format", "{{.DockerRootDir}}"],
				{ env, timeout: 30_000, maxBuffer: 4096 },
			);
			const root = stdout.trim();
			if (!/^\/[^:\r\n]+$/u.test(root))
				throw new Error("invalid docker data root");
			return root;
		},
		async pruneBuilder(keepStorage) {
			await exec(docker, builderPruneArgs(keepStorage), {
				env,
				timeout: 300_000,
				maxBuffer: 1024 * 1024,
			});
		},
		async listImages(): Promise<readonly WorkerImage[]> {
			const [{ stdout }, { stdout: running }] = await Promise.all([
				exec(docker, ["image", "ls", "--no-trunc", "--format", "{{json .}}"], {
					env,
					timeout: 30_000,
					maxBuffer: 16 * 1024 * 1024,
				}),
				exec(docker, ["ps", "--no-trunc", "--format", "{{.Image}}"], {
					env,
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
				}),
			]);
			const inUse = new Set(running.split("\n").map((line) => line.trim()));
			const images = stdout.trim()
				? stdout
						.trim()
						.split("\n")
						.map((line) => dockerImage.parse(JSON.parse(line)))
				: [];
			const tagged = images
				.filter(
					(image) => image.Repository !== "<none>" && image.Tag !== "<none>",
				)
				.map((image) => ({
					id: image.ID,
					tag: `${image.Repository}:${image.Tag}`,
					created: image.CreatedAt.replace(" ", "T").replace(
						/ ([+-]\d{2})(\d{2}) UTC$/u,
						"$1:$2",
					),
				}));
			const inUseIds = new Set(
				tagged
					.filter((image) => inUse.has(image.tag) || inUse.has(image.id))
					.map((image) => image.id),
			);
			return tagged.map((image) => ({
				...image,
				inUse: inUseIds.has(image.id),
			}));
		},
		async removeImage(tag) {
			if (!/^hobo-ci-(?:deps(?:-fetch)?|worker):[A-Za-z0-9_.-]+$/u.test(tag))
				throw new Error("invalid worker image tag");
			await exec(docker, ["image", "rm", "--no-prune", tag], {
				env,
				timeout: 120_000,
				maxBuffer: 1024 * 1024,
			});
		},
		async pruneDanglingImages() {
			await exec(docker, ["image", "prune", "--force"], {
				env,
				timeout: 300_000,
				maxBuffer: 1024 * 1024,
			});
		},
		async containerExists(name) {
			try {
				await exec(docker, ["container", "inspect", name], {
					env,
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
				});
				return true;
			} catch (error) {
				if (
					error instanceof Error &&
					Object.getOwnPropertyDescriptor(error, "code")?.value === 1
				)
					return false;
				throw error;
			}
		},
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
			return withBlkioFallback(spec, async (includeBlkio) => {
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
				args.push(...containerResourceArgs(spec, includeBlkio));
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
			});
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
		async updateResources(containerId, weights: ContainerResourceWeights) {
			await withBlkioFallback(weights, async (includeBlkio) => {
				await exec(
					docker,
					[
						"update",
						...containerResourceArgs(weights, includeBlkio),
						containerId,
					],
					{ env, timeout: 30_000, maxBuffer: 4096 },
				);
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
		async exitState(_name, containerId) {
			const { stdout } = await exec(
				docker,
				[
					"inspect",
					"--format",
					"{{.State.ExitCode}} {{.State.OOMKilled}}",
					containerId,
				],
				{ env, timeout: 30_000, maxBuffer: 4096 },
			);
			const match = /^(\d+) (true|false)$/.exec(stdout.trim());
			if (!match?.[1] || !match[2])
				throw new Error("invalid container exit state");
			return { exitCode: Number(match[1]), oomKilled: match[2] === "true" };
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
