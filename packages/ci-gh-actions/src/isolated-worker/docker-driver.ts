export type ContainerResourceWeights = Readonly<{
	cpuShares: number;
	blkioWeight?: number;
}>;

export type IsolatedContainerSpec = Readonly<{
	name: string;
	image: string;
	timeoutMs: number;
	env: Record<string, string>;
	command: readonly string[];
	runAsUser?: string;
	memoryMb?: number;
	cpuShares?: number;
	blkioWeight?: number;
	volumes?: readonly Readonly<{
		source: string;
		target: string;
		readonly?: boolean;
	}>[];
}>;

export function containerResourceWeightsForRank(
	rank: number,
): ContainerResourceWeights {
	if (!Number.isInteger(rank) || rank < 0 || rank > 2)
		throw new Error("invalid admission rank");
	return rank === 0
		? { cpuShares: 8_192, blkioWeight: 800 }
		: { cpuShares: 512, blkioWeight: 200 };
}

export type IsolatedContainerHandle = Readonly<{
	name: string;
	containerId: string;
}>;

export type DockerContainerState =
	| "created"
	| "restarting"
	| "running"
	| "removing"
	| "paused"
	| "exited"
	| "dead";

export type DockerContainer = Readonly<{
	name: string;
	containerId: string;
	state: DockerContainerState;
	createdAtMs?: number;
	timeoutMs?: number;
	labels?: Readonly<Record<string, string>>;
}>;

export type DockerImageInspection = Readonly<{
	id: string;
	repoTags: readonly string[];
	labels: Readonly<Record<string, string>>;
}>;

export interface DockerDriver {
	inspectImage?(image: string): Promise<DockerImageInspection>;
	probeImage?(
		image: string,
		argv: readonly string[],
		runAsUser: string,
	): Promise<{ exitCode: number }>;
	list?(label: string): Promise<readonly DockerContainer[]>;
	listWorkerContainers?(): Promise<readonly DockerContainer[]>;
	containerExists?(name: string): Promise<boolean>;
	create(spec: IsolatedContainerSpec): Promise<IsolatedContainerHandle>;
	start(name: string, containerId: string): Promise<void>;
	exec(
		name: string,
		containerId: string,
		argv: readonly string[],
	): Promise<{ exitCode: number }>;
	execDetached?(
		name: string,
		containerId: string,
		argv: readonly string[],
	): Promise<{ exitCode: number }>;
	writeSecret?(
		name: string,
		containerId: string,
		path: string,
		content: string,
	): Promise<void>;
	rename?(containerId: string, name: string): Promise<void>;
	updateResources?(
		containerId: string,
		weights: ContainerResourceWeights,
	): Promise<void>;
	memoryPeak?(name: string, containerId: string): Promise<number | undefined>;
	stop(name: string, containerId: string): Promise<void>;
	remove(name: string, containerId: string): Promise<void>;
	isRunning(name: string, containerId: string): Promise<boolean>;
	exitState?(
		name: string,
		containerId: string,
	): Promise<Readonly<{ exitCode: number; oomKilled: boolean }>>;
	exists?(name: string, containerId: string, path: string): Promise<boolean>;
	readContainerFile?(
		name: string,
		containerId: string,
		path: string,
		maxBytes?: number,
	): Promise<string | undefined>;
}
