/** Turbo parallelism; self-hosted hobo runners set HOBO_TURBO_CONCURRENCY (default 100%). */
export function turboConcurrencyArg(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env.HOBO_TURBO_CONCURRENCY?.trim();
	if (!configured) return "--concurrency=100%";
	return `--concurrency=${configured}`;
}
