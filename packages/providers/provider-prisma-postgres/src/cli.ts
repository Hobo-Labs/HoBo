/**
 * Invoking the official `create-db` CLI.
 *
 * The version is **pinned**. `create-db@latest` in a provisioning path means
 * an unreviewed third-party program, chosen at runtime by npm, is handed the
 * job of minting a credential. Pinning turns that into a reviewable
 * dependency; a version bump is a code change with a diff.
 *
 * Everything is an argv array through an injected {@link ProcessRunner}. There
 * is no shell and no interpolation, so a region or user-agent value cannot
 * become a second command.
 */
import { PrismaProviderError } from "./errors.js";

/**
 * Reviewed and pinned. Bumping this is a deliberate change: re-read the CLI's
 * `--json` output shape (`DatabaseResult`/`DatabaseError`) before you do.
 * Latest published version at review time (2026-08-08) was also 1.2.1.
 */
// public-contract: audited create-db version used by the provider adapter.
export const PINNED_CREATE_DB_VERSION = "1.2.1";
// public-contract: package identity used in generated execution plans.
export const CREATE_DB_PACKAGE = "create-db";
// public-contract: immutable package specifier shown in offers and receipts.
export const PINNED_CREATE_DB_SPECIFIER = `${CREATE_DB_PACKAGE}@${PINNED_CREATE_DB_VERSION}`;

/** Regions the pinned CLI accepts. Anything else is rejected before spawning. */
export const PRISMA_REGIONS = [
	"ap-northeast-1",
	"ap-southeast-1",
	"eu-central-1",
	"eu-west-3",
	"us-east-1",
	"us-west-1",
] as const;

export type PrismaRegion = (typeof PRISMA_REGIONS)[number];

export type ProcessRunOptions = {
	readonly env: Readonly<Record<string, string>>;
	readonly stdin?: string;
	readonly timeoutMs: number;
	readonly cwd?: string;
};

export type ProcessResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Implementations MUST spawn without a shell and MUST NOT inherit the ambient
 * environment beyond `env`.
 */
export interface ProcessRunner {
	run(
		argv: readonly string[],
		options: ProcessRunOptions,
	): Promise<ProcessResult>;
}

export type CreateDbInvocation = {
	readonly argv: readonly string[];
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
};

export type CreateDbInvocationInput = {
	readonly region?: PrismaRegion;
	/** Launcher. `npx` by default; a host may point at a vendored binary. */
	readonly launcher?: readonly string[];
	readonly userAgent?: string;
	/**
	 * Requested lifetime. The pinned CLI accepts `30m` or `1h`–`24h`; omitting
	 * it takes the documented 24-hour default. A shorter TTL is the cheapest
	 * available blast-radius control on an anonymous database, so it is worth
	 * being able to ask for one.
	 */
	readonly ttl?: string;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	/**
	 * Ask for the machine-readable document. Default `true`; set false only for
	 * a host pinned to a CLI build without `--json`, which then has to read the
	 * narrow `human-v1` output.
	 */
	readonly json?: boolean;
};

export const DEFAULT_CLI_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * A launcher or flag token. The leading `-` is allowed because `--yes` is a
 * legitimate argv element; everything a shell would find interesting — spaces,
 * `;`, `|`, `&`, `$`, backticks, newlines, NUL — is not in the class at all, so
 * a hostile value is refused rather than escaped.
 */
const SAFE_TOKEN = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._@/+-]{0,127}$/u;

/** Exactly the range the pinned CLI's `--ttl` parser accepts. */
export const CREATE_DB_TTL = /^(?:30m|(?:1[0-9]|2[0-4]|[1-9])h)$/u;

function assertSafeToken(value: string, what: string): string {
	if (!SAFE_TOKEN.test(value)) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${what} must be a plain identifier token`,
		);
	}
	return value;
}

/**
 * Build the argv for a create. `create` is the CLI's registered default
 * command; naming it explicitly means a future change to the default cannot
 * silently redirect this call.
 */
export function buildCreateDbArgv(
	input: CreateDbInvocationInput = {},
): CreateDbInvocation {
	const launcher = input.launcher ?? ["npx", "--yes"];
	for (const token of launcher) assertSafeToken(token, "launcher token");
	if (input.region !== undefined && !PRISMA_REGIONS.includes(input.region)) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`region ${String(input.region)} is not one of the documented Prisma Postgres regions`,
		);
	}
	if (input.ttl !== undefined && !CREATE_DB_TTL.test(input.ttl)) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`ttl ${JSON.stringify(input.ttl)} is not one of the accepted values 30m or 1h-24h`,
		);
	}
	const argv = [
		...launcher,
		PINNED_CREATE_DB_SPECIFIER,
		"create",
		...(input.json === false ? [] : ["--json"]),
		...(input.region !== undefined ? [`--region=${input.region}`] : []),
		...(input.ttl !== undefined ? [`--ttl=${input.ttl}`] : []),
		...(input.userAgent !== undefined
			? [`--user-agent=${assertSafeToken(input.userAgent, "user agent")}`]
			: []),
	];
	return {
		argv,
		timeoutMs: input.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
		maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
	};
}

/** The child sees a deliberately small environment, never `process.env`. */
export function createDbEnv(
	overrides: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
	return Object.freeze({
		CI: "1",
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		...overrides,
	});
}

export function assertBoundedOutput(
	text: string,
	maxOutputBytes: number,
	stream: string,
): string {
	if (Buffer.byteLength(text, "utf8") > maxOutputBytes) {
		throw new PrismaProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`create-db ${stream} exceeded the ${maxOutputBytes} byte cap`,
		);
	}
	return text;
}
