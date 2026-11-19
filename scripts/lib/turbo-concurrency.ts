export function turboConcurrencyArg(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configured = env.HOBO_TURBO_CONCURRENCY?.trim();
	if (!configured) return "--concurrency=100%";
	return `--concurrency=${configured}`;
}
