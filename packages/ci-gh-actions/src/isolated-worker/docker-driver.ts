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
	/** Rename a pre-warmed container to the lease's identity. */
	rename?(containerId: string, name: string): Promise<void>;
	stop(name: string, containerId: string): Promise<void>;
	remove(name: string, containerId: string): Promise<void>;
	isRunning(name: string, containerId: string): Promise<boolean>;
}
