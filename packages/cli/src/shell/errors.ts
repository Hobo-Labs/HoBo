export class CliError extends Error {
	readonly exitCode: number;
	readonly code: string;
	readonly remediation: readonly string[];

	constructor(
		message: string,
		exitCode: number,
		code: string,
		remediation: readonly string[] = [],
	) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
		this.code = code;
		this.remediation = remediation;
	}
}

export class UsageError extends CliError {
	constructor(
		message: string,
		remediation: readonly string[] = defaultUsageRemediation(),
	) {
		super(message, 2, "HOBO_CLI_USAGE", remediation);
		this.name = "UsageError";
	}
}

export class NoBindleError extends CliError {
	constructor(cwd: string, options: { readonly monorepo?: boolean } = {}) {
		const monorepo = options.monorepo === true;
		super(
			monorepo
				? `No Bindle here: ${cwd}\nThis looks like the HoBo monorepo root, not an app.`
				: `No Bindle here: ${cwd}\nRun from a HoBo project or pass --cwd <path> to one.`,
			1,
			"HOBO_NO_BINDLE",
			monorepo
				? [
						"After `pnpm install` and `pnpm exec turbo run build --filter @hobo/adapter-hono --filter @hobo/hobo`, try `hobo doctor --cwd examples/hello-bindle`.",
						"Pass `--cwd <path>` to a directory with `src/bindle.ts` or `hobo.bindle.json`.",
					]
				: [
						"Pass `--cwd <path>` to a directory with `src/bindle.ts` or `hobo.bindle.json`.",
						"Do not run `npx hobo` — `@hobo/*` is not on npm.",
					],
		);
		this.name = "NoBindleError";
	}
}

export class BindleImportError extends CliError {
	constructor(sourcePath: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`Bindle at ${sourcePath} failed to load: ${detail}`,
			1,
			"HOBO_BINDLE_IMPORT",
			[
				"Build workspace deps the Bindle imports (hello-bindle needs `pnpm exec turbo run build --filter @hobo/adapter-hono`).",
				"Use the composed `@hobo/hobo` binary after a workspace build, not a half-built zip.",
			],
		);
		this.name = "BindleImportError";
		this.cause = cause;
	}
}

function defaultUsageRemediation(): readonly string[] {
	return ["Run `hobo --help` for the canonical verb list and global flags."];
}
