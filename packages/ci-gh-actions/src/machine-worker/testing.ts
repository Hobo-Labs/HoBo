import {
	RUNNER_EXIT_CODE_PATH,
	RUNNER_EXITED_PATH,
} from "../isolated-worker/container-controller.js";
import type {
	DockerDriver,
	IsolatedContainerHandle,
	IsolatedContainerSpec,
} from "../isolated-worker/docker-driver.js";
import { type HostProcess, RUNNER_JIT_CONFIG_ENV } from "./executor.js";

export type FakeRunnerStart = Readonly<{
	where: string;
	encodedJitConfig: string;
	env: ReadonlyMap<string, string>;
	signal: AbortSignal;
}>;

export type FakeRunnerProgram = (start: FakeRunnerStart) => Promise<number>;

export type FakeContainer = {
	readonly spec: IsolatedContainerSpec;
	readonly containerId: string;
	started: boolean;
	stopped: boolean;
	removed: boolean;
	readonly secrets: Map<string, string>;
	readonly commands: string[][];
	exitCode: number | undefined;
};

export class FakeContainerDriver implements DockerDriver {
	readonly containers: FakeContainer[] = [];
	private readonly stops = new Map<string, AbortController>();

	constructor(private readonly program: FakeRunnerProgram) {}

	private find(containerId: string): FakeContainer {
		const container = this.containers.find(
			(found) => found.containerId === containerId,
		);
		if (!container) throw new Error(`no container ${containerId}`);
		return container;
	}

	readonly create = async (
		spec: IsolatedContainerSpec,
	): Promise<IsolatedContainerHandle> => {
		if (
			this.containers.some(
				(found) => found.spec.name === spec.name && !found.removed,
			)
		)
			throw new Error(`a container named ${spec.name} already exists`);
		const containerId = String(this.containers.length + 1).padStart(64, "0");
		this.containers.push({
			spec,
			containerId,
			started: false,
			stopped: false,
			removed: false,
			secrets: new Map(),
			commands: [],
			exitCode: undefined,
		});
		return { name: spec.name, containerId };
	};

	readonly start = async (
		_name: string,
		containerId: string,
	): Promise<void> => {
		this.find(containerId).started = true;
	};

	readonly writeSecret = async (
		_name: string,
		containerId: string,
		path: string,
		content: string,
	): Promise<void> => {
		this.find(containerId).secrets.set(path, content);
	};

	readonly exec = async (
		name: string,
		containerId: string,
		argv: readonly string[],
	): Promise<{ exitCode: number }> => {
		return this.execDetached(name, containerId, argv);
	};

	readonly execDetached = async (
		name: string,
		containerId: string,
		argv: readonly string[],
	): Promise<{ exitCode: number }> => {
		const container = this.find(containerId);
		container.commands.push([...argv]);
		const jit = [...container.secrets.values()][0];
		if (jit === undefined) return { exitCode: 1 };
		const stop = new AbortController();
		this.stops.set(containerId, stop);
		void this.program({
			where: name,
			encodedJitConfig: jit,
			env: new Map(Object.entries(container.spec.env)),
			signal: stop.signal,
		})
			.catch(() => 1)
			.then((code) => {
				container.exitCode = code;
			});
		return { exitCode: 0 };
	};

	readonly exists = async (
		_name: string,
		containerId: string,
		path: string,
	): Promise<boolean> => {
		const container = this.find(containerId);
		return path === RUNNER_EXITED_PATH && container.exitCode !== undefined;
	};

	readonly readContainerFile = async (
		_name: string,
		containerId: string,
		path: string,
	): Promise<string | undefined> => {
		const container = this.find(containerId);
		return path === RUNNER_EXIT_CODE_PATH && container.exitCode !== undefined
			? `${container.exitCode}\n`
			: undefined;
	};

	readonly isRunning = async (
		_name: string,
		containerId: string,
	): Promise<boolean> => {
		const container = this.find(containerId);
		return container.started && !container.stopped && !container.removed;
	};

	readonly stop = async (_name: string, containerId: string): Promise<void> => {
		this.find(containerId).stopped = true;
		this.stops.get(containerId)?.abort();
	};

	readonly remove = async (
		_name: string,
		containerId: string,
	): Promise<void> => {
		this.find(containerId).removed = true;
	};

	alive(): readonly FakeContainer[] {
		return this.containers.filter((container) => !container.removed);
	}
}

export type FakeHostCall = Readonly<{
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
}>;

export type FakeHostProcess = Readonly<{
	process: HostProcess;
	calls: FakeHostCall[];
}>;

export function fakeHostProcess(program: FakeRunnerProgram): FakeHostProcess {
	const calls: FakeHostCall[] = [];
	return {
		calls,
		async process(command, args, cwd, env, signal) {
			calls.push({ command, args: [...args], env: { ...env } });
			if (!command.endsWith("run.sh")) return 0;
			const entries = Object.entries(env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			);
			return program({
				where: cwd,
				encodedJitConfig: env[RUNNER_JIT_CONFIG_ENV] ?? "",
				env: new Map(entries),
				signal,
			});
		},
	};
}
