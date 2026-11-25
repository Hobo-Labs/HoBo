import type { SpawnSyncReturns } from "node:child_process";

export function spawnFailClosedCode(
	result: SpawnSyncReturns<Buffer | string>,
): number | null {
	if (result.error) {
		return 1;
	}
	if (result.signal) {
		return 1;
	}
	if (result.status !== 0) {
		return result.status ?? 1;
	}
	return null;
}

export function exitSpawnFailClosed(
	label: string,
	result: SpawnSyncReturns<Buffer | string>,
): void {
	const code = spawnFailClosedCode(result);
	if (code === null) {
		return;
	}
	if (result.error) {
		process.stderr.write(`${label}: spawn failed: ${result.error.message}\n`);
		process.exit(code);
	}
	if (result.signal) {
		process.stderr.write(`${label}: killed by signal ${result.signal}\n`);
		process.exit(code);
	}
	process.stderr.write(
		`${label}: exited with status ${result.status ?? "unknown"}\n`,
	);
	process.exit(code);
}
