import { type SpawnSyncReturns, spawnSync } from "node:child_process";

export type TurboInvoke = Readonly<{
	command: string;
	prefix: readonly string[];
}>;

/** How CI invokes turbo: `pnpm exec` in full jobs, `mise exec` in install-free planners. */
export function resolveTurboInvoke(): TurboInvoke {
	const mode = process.env.HOBO_TURBO_INVOKER?.trim();
	if (mode === "mise") {
		return { command: "mise", prefix: ["exec", "--", "turbo"] };
	}
	return { command: "pnpm", prefix: ["exec", "turbo"] };
}

export function spawnTurbo(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
	const { command, prefix } = resolveTurboInvoke();
	return spawnSync(command, [...prefix, ...args], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		env,
	});
}
