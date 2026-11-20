// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export interface CliClients {
	readonly readApi: string;
	readonly runtime: string;
}

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export interface CliContext {
	readonly cwd: string;
	readonly projectDir: string | null;
	readonly identity: string | null;
	readonly clients: CliClients;
}

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export interface CliEnvelope {
	readonly ok: boolean;
	readonly verb: string;
	readonly status: string;
	readonly code: string;
	readonly message: string;
	readonly remediation: readonly string[];
	readonly context: CliContext;
	readonly data: CommandData;
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
export type CommandData = Readonly<Record<string, unknown>>;

export interface CommandResult {
	readonly ok?: boolean;
	readonly status?: string;
	readonly code?: string;
	readonly message?: string;
	readonly remediation?: readonly string[];
	readonly data?: CommandData;
}

export function publicContext(context: CliContext): CliContext {
	return {
		cwd: context.cwd,
		projectDir: context.projectDir,
		identity: context.identity ?? null,
		clients: context.clients,
	};
}

export function buildEnvelope(input: {
	verb: string;
	context: CliContext;
	result: CommandResult;
}): CliEnvelope {
	const ok = input.result.ok !== false;
	return {
		ok,
		verb: input.verb,
		status: input.result.status ?? (ok ? "ok" : "error"),
		code: input.result.code ?? (ok ? "HOBO_OK" : "HOBO_CLI_ERROR"),
		message: input.result.message ?? "",
		remediation: input.result.remediation ?? [],
		context: publicContext(input.context),
		data: input.result.data ?? {},
	};
}
