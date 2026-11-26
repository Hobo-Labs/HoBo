/** Per-job backoff after a JIT runner exits without receiving work (job still queued). */

export type JitEmptyExitState = Readonly<{
	count: number;
	nextLaunchMs: number;
}>;

export type JitEmptyExitBackoffOptions = Readonly<{
	/** First delay after the first empty exit (default 30s). */
	baseMs?: number;
	/** Cap per delay (default 10m). */
	maxMs?: number;
}>;

const DEFAULT_BASE_MS = 30_000;
const DEFAULT_MAX_MS = 10 * 60_000;

export function jitEmptyExitKey(
	repositoryId: number,
	jobId: number,
	runAttempt: number,
): string {
	return `${repositoryId}:${jobId}:${runAttempt}`;
}

export function nextJitEmptyExitDelayMs(
	count: number,
	options?: JitEmptyExitBackoffOptions,
): number {
	if (count <= 0) return 0;
	const base = options?.baseMs ?? DEFAULT_BASE_MS;
	const max = options?.maxMs ?? DEFAULT_MAX_MS;
	const exponent = Math.max(0, count - 1);
	return Math.min(max, base * 2 ** exponent);
}

export function recordJitEmptyExit(
	store: Map<string, JitEmptyExitState>,
	key: string,
	nowMs: number,
	options?: JitEmptyExitBackoffOptions,
): JitEmptyExitState {
	const previous = store.get(key);
	const count = (previous?.count ?? 0) + 1;
	const delayMs = nextJitEmptyExitDelayMs(count, options);
	const next: JitEmptyExitState = {
		count,
		nextLaunchMs: nowMs + delayMs,
	};
	store.set(key, next);
	return next;
}

export function jitEmptyExitLaunchBlocked(
	store: Map<string, JitEmptyExitState>,
	key: string,
	nowMs: number,
): JitEmptyExitState | undefined {
	const state = store.get(key);
	if (!state || nowMs >= state.nextLaunchMs) return undefined;
	return state;
}

export function clearJitEmptyExit(
	store: Map<string, JitEmptyExitState>,
	key: string,
): void {
	store.delete(key);
}
