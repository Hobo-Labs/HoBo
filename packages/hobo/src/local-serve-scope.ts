import { isJsonString } from "./json.js";

type Cleanup = () => void | Promise<void>;

type EnvironmentWrite = {
	readonly owner: symbol;
	readonly value: string;
};

type EnvironmentState = {
	readonly original: string | undefined;
	readonly writes: EnvironmentWrite[];
	externallyModified: boolean;
};

const environmentStates = new Map<string, EnvironmentState>();

export function createLocalServeScope() {
	const owner = Symbol("local serve");
	const keys = new Set<string>();
	const cleanups: Cleanup[] = [];
	let closing: Promise<void> | undefined;

	function setEnv(key: string, value: string): void {
		if (closing !== undefined) throw new Error("local serve scope is closed");
		let state = environmentStates.get(key);
		const previousWrite = state?.writes.at(-1);
		if (
			state !== undefined &&
			(state.externallyModified || previousWrite?.value !== process.env[key])
		) {
			environmentStates.delete(key);
			state = undefined;
		}
		if (state === undefined) {
			state = {
				original: process.env[key],
				writes: [],
				externallyModified: false,
			};
			environmentStates.set(key, state);
		}
		const previousIndex = state.writes.findIndex(
			(write) => write.owner === owner,
		);
		if (previousIndex !== -1) state.writes.splice(previousIndex, 1);
		state.writes.push({ owner, value });
		keys.add(key);
		process.env[key] = value;
	}

	function restoreEnv(): void {
		for (const key of keys) {
			const state = environmentStates.get(key);
			if (state === undefined) continue;
			const index = state.writes.findIndex((write) => write.owner === owner);
			if (index === -1) continue;
			const last = state.writes.at(-1);
			if (last?.value !== process.env[key]) state.externallyModified = true;
			const wasLast = index === state.writes.length - 1;
			state.writes.splice(index, 1);
			if (wasLast && !state.externallyModified) {
				const value = state.writes.at(-1)?.value ?? state.original;
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (state.writes.length === 0) environmentStates.delete(key);
		}
		keys.clear();
	}

	async function release(): Promise<void> {
		let failed = false;
		let failure: unknown;
		for (const cleanup of cleanups.splice(0).reverse()) {
			try {
				await cleanup();
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
		restoreEnv();
		if (failed) throw failure;
	}

	return {
		setEnv,
		processEnv(): NodeJS.ProcessEnv {
			return new Proxy(
				{ ...process.env },
				{
					set(target, property, value) {
						if (isJsonString(property) && isJsonString(value)) {
							setEnv(property, value);
						}
						return Reflect.set(target, property, value);
					},
				},
			);
		},
		defer(cleanup: Cleanup): void {
			if (closing !== undefined) throw new Error("local serve scope is closed");
			cleanups.push(cleanup);
		},
		close(): Promise<void> {
			closing ??= release();
			return closing;
		},
	};
}
