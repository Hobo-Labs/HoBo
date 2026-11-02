export type IsolatedContainerSpec = Readonly<{
	name: string;
	image: string;
	timeoutMs: number;
	env: Record<string, string>;
	command: readonly string[];
	runAsUser?: string;
	memoryMb?: number;
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
	stop(name: string, containerId: string): Promise<void>;
	remove(name: string, containerId: string): Promise<void>;
	isRunning(name: string, containerId: string): Promise<boolean>;
}
