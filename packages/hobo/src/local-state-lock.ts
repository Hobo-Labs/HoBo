import { resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class LocalStateLockBusyError extends Error {}

/** OS-owned mutex: closing the connection or process death releases ownership. */
export function acquireLocalStateLock(path: string): () => void {
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch (cause) {
		database.close();
		if (
			cause instanceof Error &&
			"errcode" in cause &&
			(cause.errcode === 5 || cause.errcode === 6)
		)
			throw new LocalStateLockBusyError(
				"Another operation holds the local state lock",
				{
					cause,
				},
			);
		throw cause;
	}
	return () => database.close();
}

interface LocalStateLockQueueOptions {
	readonly acquire?: (path: string) => () => void;
	readonly now?: () => number;
	readonly schedule?: (delay: number) => Promise<void>;
	readonly timeoutMs?: number;
	readonly retryDelayMs?: number;
}

type ResolvedLocalStateLockQueueOptions = Required<LocalStateLockQueueOptions>;

interface LocalStateLockWaiter {
	readonly options: ResolvedLocalStateLockQueueOptions;
	readonly deadline: number;
	readonly grant: (release: () => void) => void;
	readonly fail: (error: Error) => void;
}

interface LocalStateLockQueue {
	readonly waiters: LocalStateLockWaiter[];
}

const localStateLockQueues = new Map<string, LocalStateLockQueue>();
const scheduleLocalStateLockRetry = (delay: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, delay);
	});

function startNextLocalStateLock(
	path: string,
	queue: LocalStateLockQueue,
): void {
	if (queue.waiters.length === 0) {
		localStateLockQueues.delete(path);
		return;
	}
	void grantLocalStateLock(path, queue);
}

async function grantLocalStateLock(
	path: string,
	queue: LocalStateLockQueue,
): Promise<void> {
	const waiter = queue.waiters[0];
	if (!waiter) return;
	try {
		for (;;) {
			try {
				const release = waiter.options.acquire(path);
				let released = false;
				waiter.grant(() => {
					if (released) return;
					released = true;
					release();
					queue.waiters.shift();
					startNextLocalStateLock(path, queue);
				});
				return;
			} catch (error) {
				if (
					!(error instanceof LocalStateLockBusyError) ||
					waiter.options.now() >= waiter.deadline
				)
					throw error;
				await waiter.options.schedule(waiter.options.retryDelayMs);
			}
		}
	} catch (error) {
		queue.waiters.shift();
		waiter.fail(
			error instanceof Error
				? error
				: new Error("Local state lock acquisition failed", { cause: error }),
		);
		startNextLocalStateLock(path, queue);
	}
}

export function acquireLocalStateLockQueued(
	path: string,
	options: LocalStateLockQueueOptions = {},
): Promise<() => void> {
	const key = resolvePath(path);
	const resolvedOptions: ResolvedLocalStateLockQueueOptions = {
		acquire: options.acquire ?? acquireLocalStateLock,
		now: options.now ?? Date.now,
		schedule: options.schedule ?? scheduleLocalStateLockRetry,
		timeoutMs: options.timeoutMs ?? 120_000,
		retryDelayMs: options.retryDelayMs ?? 25,
	};
	let queue = localStateLockQueues.get(key);
	if (!queue) {
		queue = { waiters: [] };
		localStateLockQueues.set(key, queue);
	}
	return new Promise((grant, fail) => {
		const waiter: LocalStateLockWaiter = {
			options: resolvedOptions,
			deadline: resolvedOptions.now() + resolvedOptions.timeoutMs,
			grant,
			fail,
		};
		queue.waiters.push(waiter);
		if (queue.waiters.length === 1) void grantLocalStateLock(key, queue);
	});
}

export async function withLocalStateLockQueued<T>(
	path: string,
	operation: () => Promise<T>,
	options: LocalStateLockQueueOptions = {},
): Promise<T> {
	const release = await acquireLocalStateLockQueued(path, options);
	try {
		return await operation();
	} finally {
		release();
	}
}
