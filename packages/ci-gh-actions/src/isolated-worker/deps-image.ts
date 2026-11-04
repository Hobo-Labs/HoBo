import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultDepsRoot(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "../../..");
}

export type DepsImageAction = "hit" | "pull" | "build";

export type DepsImageEvent = Readonly<
	| {
			event: "hobo_ci_deps_image_ensure_started";
			key: string;
	  }
	| {
			event: "hobo_ci_deps_image_ensure";
			key: string;
			action: DepsImageAction;
			ms: number;
	  }
	| {
			event: "hobo_ci_deps_image_ensure_failed";
			key: string;
			action: DepsImageAction;
			ms: number;
			message: string;
			retryMs: number;
	  }
>;

export type DepsImageEnsureResult = Readonly<
	| { status: "unchanged" }
	| { status: "backoff"; retryMs: number }
	| { status: "ensured"; key: string; action: DepsImageAction; ms: number }
	| {
			status: "failed";
			key: string;
			action: DepsImageAction;
			ms: number;
			message: string;
			retryMs: number;
	  }
>;

export interface DepsImageGitPort {
	defaultBranchHead(root: string): Promise<string>;
}

export interface DepsImageFileSystemPort {
	depsKey(root: string, toolchain: string): Promise<string>;
}

export interface DepsImageDockerPort {
	toolchain(root: string): Promise<string>;
	imageExists(image: string): Promise<boolean>;
	pull(image: string): Promise<void>;
	tag(source: string, target: string): Promise<void>;
}

export interface DepsImageProcessRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export interface DepsImageProcessPort {
	run(request: DepsImageProcessRequest): Promise<void>;
}

export interface DepsImageEnsurerOptions {
	readonly root: string;
	readonly repository: string;
	readonly buildMemoryMb: number;
	readonly git: DepsImageGitPort;
	readonly fs: DepsImageFileSystemPort;
	readonly docker: DepsImageDockerPort;
	readonly processes: DepsImageProcessPort;
	readonly now?: () => number;
	readonly initialRetryMs?: number;
	readonly maxRetryMs?: number;
	readonly onEvent?: (event: DepsImageEvent) => void;
}

export function createDepsImageEnsurer(options: DepsImageEnsurerOptions) {
	const now = options.now ?? Date.now;
	const initialRetryMs = options.initialRetryMs ?? 60_000;
	const maxRetryMs = options.maxRetryMs ?? 15 * 60_000;
	const candidateFor = (key: string) => `hobo-ci-deps:${key}`;
	const remoteFor = (key: string) =>
		`ghcr.io/${options.repository.toLowerCase()}/hobo-ci-deps:${key}`;
	let lastHead: string | undefined;
	let lastKey: string | undefined;
	let failures = 0;
	let retryAt = 0;
	let active: Promise<DepsImageEnsureResult> | undefined;

	async function perform(): Promise<DepsImageEnsureResult> {
		const started = now();
		let key = "unknown";
		let action: DepsImageAction = "hit";
		try {
			const head = await options.git.defaultBranchHead(options.root);
			if (head === lastHead && lastKey !== undefined)
				return { status: "unchanged" };
			const toolchain = await options.docker.toolchain(options.root);
			key = await options.fs.depsKey(options.root, toolchain);
			if (key === lastKey) {
				lastHead = head;
				return { status: "unchanged" };
			}
			options.onEvent?.({ event: "hobo_ci_deps_image_ensure_started", key });
			const candidate = candidateFor(key);
			if (!(await options.docker.imageExists(candidate))) {
				const remote = remoteFor(key);
				try {
					await options.docker.pull(remote);
					action = "pull";
					await options.docker.tag(remote, candidate);
				} catch {
					action = "build";
					await options.processes.run({
						command: "nice",
						args: [
							"-n",
							"10",
							"ionice",
							"-c",
							"2",
							"-n",
							"7",
							"bash",
							"packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
							"--no-promote",
						],
						cwd: options.root,
						env: {
							...process.env,
							HOBO_CI_DEPS_BUILD_MEMORY_MB: String(options.buildMemoryMb),
						},
					});
				}
			}
			await options.processes.run({
				command: process.execPath,
				args: [
					"--import",
					"tsx",
					"--test",
					"scripts/test/ci-deps-image-mount.test.ts",
				],
				cwd: options.root,
				env: {
					...process.env,
					HOBO_CI_DEPS_MOUNT_CONTRACT: "1",
					HOBO_CI_DEPS_IMAGE: candidate,
					HOBO_CI_DEPS_LAYER: key,
				},
			});
			await options.docker.tag(candidate, "hobo-ci-deps:local");
			await options.processes.run({
				command: process.execPath,
				args: [
					"--experimental-strip-types",
					"--no-warnings",
					"scripts/ci-runner-image-gc.mts",
					candidate,
				],
				cwd: options.root,
				env: process.env,
			});
			lastHead = head;
			lastKey = key;
			failures = 0;
			retryAt = 0;
			const ms = Math.max(0, now() - started);
			options.onEvent?.({
				event: "hobo_ci_deps_image_ensure",
				key,
				action,
				ms,
			});
			return { status: "ensured", key, action, ms };
		} catch (error) {
			failures += 1;
			const retryMs = Math.min(
				maxRetryMs,
				initialRetryMs * 2 ** (failures - 1),
			);
			retryAt = now() + retryMs;
			const ms = Math.max(0, now() - started);
			const message = error instanceof Error ? error.message : "unknown";
			options.onEvent?.({
				event: "hobo_ci_deps_image_ensure_failed",
				key,
				action,
				ms,
				message,
				retryMs,
			});
			return { status: "failed", key, action, ms, message, retryMs };
		}
	}

	function ensure(): Promise<DepsImageEnsureResult> {
		if (active) return active;
		const retryMs = retryAt - now();
		if (retryMs > 0) return Promise.resolve({ status: "backoff", retryMs });
		active = perform().finally(() => {
			active = undefined;
		});
		return active;
	}

	return { ensure };
}
