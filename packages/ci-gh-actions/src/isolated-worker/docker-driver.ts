export type IsolatedContainerSpec = Readonly<{
	name: string;
	image: string;
	timeoutMs: number;
	env: Record<string, string>;
	command: readonly string[];
	runAsUser?: string;
	memoryMb?: number;
	/** Extra `-v src:dst` mounts (e.g. a shared pnpm store volume). */
	volumes?: readonly Readonly<{ source: string; target: string }>[];
}>;

export type IsolatedContainerHandle = Readonly<{
	name: string;
	containerId: string;
}>;

/** Ephemeral container boundary for one JIT runner session. */
export interface DockerDriver {
	create(spec: IsolatedContainerSpec): Promise<IsolatedContainerHandle>;
	start(name: string, containerId: string): Promise<void>;
	exec(
		name: string,
		containerId: string,
		argv: readonly string[],
	): Promise<{ exitCode: number }>;
	/** Start argv in the container and return without waiting for it (`docker exec -d`). */
	execDetached?(
		name: string,
		containerId: string,
		argv: readonly string[],
	): Promise<{ exitCode: number }>;
	/** Write `content` to `path` inside the container via stdin (mode 0600), never argv. */
	writeSecret?(
		name: string,
		containerId: string,
		path: string,
		content: string,
	): Promise<void>;
	/** Rename a pre-warmed container to the lease's identity. */
	rename?(containerId: string, name: string): Promise<void>;
	stop(name: string, containerId: string): Promise<void>;
	remove(name: string, containerId: string): Promise<void>;
	isRunning(name: string, containerId: string): Promise<boolean>;
	/** Whether `path` exists inside the running container; rejects when docker cannot say. */
	exists?(name: string, containerId: string, path: string): Promise<boolean>;
}
