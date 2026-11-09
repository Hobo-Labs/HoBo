/**
 * Argv construction shared by every pack operation.
 *
 * Pack operations are argv arrays handed to an injected process runner. There is
 * no shell, no string concatenation, and no interpolation, so a database named
 * `x; rm -rf /` is one inert element rather than a second command. What still
 * needs guarding is the material inside an element: a NUL truncates in `execve`,
 * a newline forges log lines, and a credential in argv is visible in `ps` to
 * every user on the host.
 */
import { PackError } from "./errors.js";

export function containsControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/** Credential shapes that must never reach a command line. */
export const ARGV_CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/postgres(?:ql)?:\/\//iu,
	/rediss?:\/\//iu,
	/(?:^|[=\s])(?:--)?(?:password|requirepass|pgpassword)[=\s]/iu,
	/\/\/[^/\s:@]+:[^/\s:@]+@/u,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

export function assertArgvValue(value: string, what: string): string {
	if (value.length === 0 || value.length > 1024) {
		throw new PackError(
			"PACK_OPERATION_FAILED",
			`${what} must be 1-1024 characters`,
		);
	}
	if (containsControlChar(value)) {
		throw new PackError(
			"PACK_OPERATION_FAILED",
			`${what} contains a control character and cannot be passed to a child process`,
		);
	}
	return value;
}

/** Last line of defence before a command is spawned. */
export function assertArgvSafe(argv: readonly string[]): readonly string[] {
	if (argv.length === 0) {
		throw new PackError(
			"PACK_OPERATION_FAILED",
			"refusing to run an empty argv",
		);
	}
	for (const element of argv) {
		assertArgvValue(element, "argv element");
		for (const pattern of ARGV_CREDENTIAL_PATTERNS) {
			if (pattern.test(element)) {
				throw new PackError(
					"PACK_OPERATION_FAILED",
					"refusing to place credential-shaped material in argv; pass it through the environment, stdin, or a file descriptor",
				);
			}
		}
	}
	return argv;
}

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
 * Implementations MUST spawn without a shell (`shell: false`) and MUST NOT
 * inherit the ambient environment beyond what `env` provides.
 */
export interface ProcessRunner {
	run(
		argv: readonly string[],
		options: ProcessRunOptions,
	): Promise<ProcessResult>;
}
