export const RELEASE_CONTRACT_SCRIPT_BUILD_FILTERS = [
	"@hobo/provider-redaction",
] as const;

export function releaseContractScriptTurboFilters(): readonly string[] {
	return RELEASE_CONTRACT_SCRIPT_BUILD_FILTERS.map(
		(name) => `--filter=${name}`,
	);
}

export function releaseContractScriptBuildCommand(): string {
	const filters = releaseContractScriptTurboFilters().join(" ");
	return `pnpm exec turbo run build ${filters} --output-logs=new-only --concurrency=${process.env.HOBO_TURBO_CONCURRENCY ?? "100%"}`;
}
