import { type SpawnSyncReturns, spawnSync } from "node:child_process";

const MAX_TLC_TIMEOUT_MS = 60_000;
const MAX_TLC_OUTPUT_BYTES = 16 * 1024 * 1024;

interface TlcTestOptions {
	readonly executable?: string;
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
}

export function assertTlcExited(result: SpawnSyncReturns<string>): void {
	if (result.error) throw result.error;
	if (result.status === null || result.signal !== null)
		throw new Error("model checker terminated without a normal exit");
}

export function runBoundedTlc(
	jar: string,
	args: readonly string[],
	cwd: string,
	testOptions: TlcTestOptions = {},
): SpawnSyncReturns<string> {
	const timeoutMs = testOptions.timeoutMs ?? MAX_TLC_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > MAX_TLC_TIMEOUT_MS
	)
		throw new RangeError("model checker timeout is outside its bound");
	return spawnSync(
		testOptions.executable ?? "java",
		[
			...(testOptions.prefixArgs ?? []),
			"-XX:+UseParallelGC",
			"-Xmx512m",
			"-cp",
			jar,
			"tlc2.TLC",
			...args,
		],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: MAX_TLC_OUTPUT_BYTES,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		},
	);
}
