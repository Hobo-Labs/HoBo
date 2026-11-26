/**
 * The subprocess boundary for the Netlify CLI, as an injected port.
 *
 * The whole anonymous deploy path is a CLI invocation, which makes argv the
 * attack surface. Three rules hold it shut:
 *
 * 1. **Arrays, never strings.** `run` takes `readonly string[]`; there is no
 *    overload that accepts a command line, so there is no shell to quote for and
 *    `; rm -rf /`, `$(id)`, and backticks are all just characters inside one
 *    element.
 * 2. **No leading dash in a value position.** Argument arrays stop shell
 *    injection but not *option* injection: a site name of `--prod` would be read
 *    as a flag by most parsers. Values are checked, not rewritten.
 * 3. **A pinned version.** `netlify deploy --allow-anonymous` is a contract with
 *    one specific CLI build. An unpinned `npx netlify-cli` silently changes that
 *    contract, and the failure shows up as an unparseable claim URL.
 */
import { spawn } from "node:child_process";

import { NetlifyProviderError } from "./provider-errors.js";

/**
 * The pinned CLI build this driver is written against.
 *
 * Source: https://registry.npmjs.org/netlify-cli/latest (checked 2026-08-08;
 * 27.1.1 published 2026-08-07). Bumping this is a contract change: re-read the
 * `--json` output shape before changing it.
 */
// public-contract: package identity used by execution plans.
export const NETLIFY_CLI_PACKAGE = "netlify-cli" as const;
// public-contract: audited CLI version used by execution plans.
export const NETLIFY_CLI_VERSION = "27.1.1" as const;
// public-contract: immutable CLI package specifier shown in receipts.
export const NETLIFY_CLI_PACKAGE_SPEC =
	`${NETLIFY_CLI_PACKAGE}@${NETLIFY_CLI_VERSION}` as const;

export type ProcessRunOptions = {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
};

export type ProcessResult = {
	/** Exit status. `null` when the child was killed by a signal. */
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Implementations MUST NOT invoke a shell, MUST NOT interpolate `argv` into a
 * string, and MUST kill the child at `timeoutMs`.
 */
export interface ProcessRunner {
	run(
		argv: readonly string[],
		options: ProcessRunOptions,
	): Promise<ProcessResult>;
}

/** Permanent credentials that must never be visible to an anonymous deploy. */
export const PERMANENT_CREDENTIAL_ENV_KEYS = [
	"NETLIFY_AUTH_TOKEN",
	"NETLIFY_ACCESS_TOKEN",
	"NETLIFY_TOKEN",
	"NETLIFY_API_TOKEN",
] as const;

/**
 * The environment an anonymous deploy runs with.
 *
 * Built by allowlist rather than by deletion: a `NETLIFY_AUTH_TOKEN` picked up
 * from an ambient shell would make the deploy *authenticated*, which quietly
 * turns a claimable site into one that already belongs to whoever owns that
 * token — and no test would notice, because the deploy still succeeds.
 */
export const ANONYMOUS_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"NODE_USE_ENV_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"npm_config_cache",
	"npm_config_registry",
] as const;

export function anonymousDeployEnv(
	source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	const env = {
		// Keep the CLI non-interactive and quiet about updates; an anonymous
		// deploy has no human at the terminal to answer a prompt.
		CI: "1",
		NETLIFY_CLI_TELEMETRY_DISABLED: "1",
		NO_COLOR: "1",
	};
	for (const key of ANONYMOUS_ENV_ALLOWLIST) {
		const value = source[key];
		if (value !== undefined && value.length > 0) {
			Object.assign(env, { [key]: value });
		}
	}
	return Object.freeze(env);
}

function argumentContainsNul(value: string): boolean {
	for (const ch of value) {
		if (ch.charCodeAt(0) === 0) return true;
	}
	return false;
}

/**
 * Check that a caller-supplied value can be passed as one argv element.
 *
 * Deliberately a check and not a sanitizer. Rewriting a hostile site name would
 * silently deploy under a different name than the caller asked for; refusing is
 * the honest outcome, and everything that *is* accepted reaches the child
 * process byte for byte as a single inert element.
 */
export function assertInertArgument(
	value: string,
	label: string,
	options: {
		readonly allowLeadingDash?: boolean;
		readonly maxLength?: number;
	} = {},
): string {
	const maxLength = options.maxLength ?? 512;
	if (value.length === 0) {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${label} must not be empty`,
		);
	}
	if (value.length > maxLength) {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${label} exceeds the ${maxLength} character limit`,
		);
	}
	if (argumentContainsNul(value)) {
		// A NUL truncates the argument inside execve, so the child would see a
		// different value than the one that was checked.
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${label} must not contain a null byte`,
		);
	}
	if (!(options.allowLeadingDash ?? false) && value.startsWith("-")) {
		throw new NetlifyProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`${label} must not begin with "-": an argument in a value position that looks like a flag is option injection`,
		);
	}
	return value;
}

export type AnonymousDeployArgvInput = {
	/** Directory of prebuilt assets, relative to the run's cwd. */
	readonly publishDir: string;
	/** Optional site name. Untrusted: it is frequently user-authored. */
	readonly siteName?: string;
	readonly deployMessage?: string;
};

/**
 * Build the argv for one anonymous deploy.
 *
 * `--no-build` is deliberate: the pre-claim profile is prebuilt static assets
 * (`web.static/v1`), so there is nothing to build, and running a build would
 * execute repository-authored commands on this path.
 *
 * Flags per the official CLI reference (checked 2026-08-08):
 * https://cli.netlify.com/commands/deploy/ — `--allow-anonymous`, `--json`,
 * `--dir`, `--no-build`, `--site-name`, `--message`.
 */
export function buildAnonymousDeployArgv(
	input: AnonymousDeployArgvInput,
): readonly string[] {
	const argv: string[] = [
		"npx",
		"--yes",
		"--package",
		NETLIFY_CLI_PACKAGE_SPEC,
		// Everything after `--` is the command npx runs, never npx's own flags.
		"--",
		"netlify",
		"deploy",
		"--allow-anonymous",
		"--no-build",
		"--json",
		"--dir",
		assertInertArgument(input.publishDir, "publish directory"),
	];
	if (input.siteName !== undefined) {
		argv.push(
			"--site-name",
			assertInertArgument(input.siteName, "site name", {
				maxLength: 63,
			}),
		);
	}
	if (input.deployMessage !== undefined) {
		argv.push(
			"--message",
			assertInertArgument(input.deployMessage, "deploy message", {
				maxLength: 200,
			}),
		);
	}
	return Object.freeze(argv);
}

/**
 * Node `child_process` adapter.
 *
 * `shell` is left at its default of `false` and the argv is split into
 * file-plus-arguments, so no part of it is ever parsed by a shell.
 */
export function createNodeProcessRunner(): ProcessRunner {
	return {
		async run(argv, options) {
			if (
				!Number.isSafeInteger(options.timeoutMs) ||
				options.timeoutMs <= 0 ||
				options.timeoutMs > 2_147_483_647 ||
				!Number.isSafeInteger(options.maxOutputBytes) ||
				options.maxOutputBytes <= 0
			)
				throw new NetlifyProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"process execution requires positive safe duration and aggregate byte bounds",
				);
			const [file, ...args] = argv;
			if (file === undefined) {
				throw new NetlifyProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"argv must name a program to run",
				);
			}
			return new Promise<ProcessResult>((resolve, reject) => {
				const child = spawn(file, args, {
					cwd: options.cwd,
					env: { ...options.env },
					stdio: ["ignore", "pipe", "pipe"],
					shell: false,
					detached: process.platform !== "win32",
				});
				let stdout = "";
				let stderr = "";
				let truncated = false;
				let capturedBytes = 0;
				const terminate = () => {
					if (process.platform !== "win32" && child.pid !== undefined) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					} else child.kill("SIGKILL");
				};
				const capture = (chunk: Buffer, into: "stdout" | "stderr"): void => {
					capturedBytes += chunk.byteLength;
					if (capturedBytes > options.maxOutputBytes) {
						truncated = true;
						terminate();
						return;
					}
					const text = chunk.toString("utf8");
					if (into === "stdout") {
						if (stdout.length + text.length > options.maxOutputBytes) {
							truncated = true;
							stdout = stdout.slice(0, options.maxOutputBytes);
							return;
						}
						stdout += text;
						return;
					}
					if (stderr.length + text.length > options.maxOutputBytes) {
						truncated = true;
						stderr = stderr.slice(0, options.maxOutputBytes);
						return;
					}
					stderr += text;
				};
				child.stdout?.on("data", (chunk: Buffer) => {
					capture(chunk, "stdout");
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					capture(chunk, "stderr");
				});
				const timer = setTimeout(() => {
					terminate();
				}, options.timeoutMs);
				child.on("error", (cause) => {
					clearTimeout(timer);
					reject(
						new NetlifyProviderError(
							"PROVIDER_CONTRACT_CHANGED",
							`the netlify cli could not be started (${NETLIFY_CLI_PACKAGE_SPEC})`,
							{
								cause:
									cause instanceof Error ? cause : new Error(String(cause)),
							},
						),
					);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					if (truncated) {
						reject(
							new NetlifyProviderError(
								"PROVIDER_OPERATION_AMBIGUOUS",
								`the netlify cli produced more than ${options.maxOutputBytes} bytes of output`,
							),
						);
						return;
					}
					resolve({ code, stdout, stderr });
				});
			});
		},
	};
}
