/**
 * `HOBO_CREDENTIALS=opensesame` (ADR-0170): the composed `hobo` takes its
 * provider credentials from OpenSesame, not from its own environment.
 *
 * The parent `hobo` composes nothing. It reads `hobo.credentials.json`
 * (references only: an OpenSesame connection and the scope a surrogate may
 * reach; never a token), relaunches itself once as
 * `opensesame dev --agent --schema <generated> run -- <this hobo invocation>`
 * through `@hobo/adapter-opensesame`'s `runProxied`, and exits with the run's
 * status: the child's own, a tripwire's 77, a signal's 128+n, or 1 for a run
 * that left placeholders or never started. The child carries
 * `HOBO_OPENSESAME_CHILD=1`, so it composes the CLI instead of relaunching, and
 * holds an `osr_` surrogate in `VERCEL_TOKEN` that only OpenSesame's proxy can
 * redeem, at `api.vercel.com`.
 *
 * In the child, `selectIacProvider` (compose.ts) calls
 * `requireOpenSesameSurrogate` before it picks a lane: a run whose plugin is
 * missing or off exits 0 and hands the child a placeholder, and an emulator
 * that accepts any token would turn that into a false green
 * (`OPENSESAME_PLACEHOLDERS_ONLY`).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
	CHILD_MARKER,
	exitCodeOf,
	OpenSesameAdapterError,
	outcomeError,
	parseCredentialBindings,
	type RunInput,
	runProxied,
	SURROGATE_PATTERN,
} from "@hobo/adapter-opensesame";
import { CANONICAL_VERBS, parseArgv } from "@hobo/cli/argv";
import { AMBIENT_CREDENTIAL_KEYS } from "@hobo/cloud";

import type { DefaultYardRuntimeOptions } from "./compose.js";
import { parseJsonValue } from "./json.js";
import type { PulumiAutomationAdapter } from "./pulumi-iac-provider.js";
import { nodeOptionsForRun } from "./relaunch-node-options.js";

// public-contract: the HOBO_CREDENTIALS value that takes credentials from OpenSesame.
export const OPENSESAME_CREDENTIALS = "opensesame";

// public-contract: the bindings file, read from the directory hobo works in, its --cwd or else the working directory (references only).
export const CREDENTIAL_BINDINGS_FILE = "hobo.credentials.json";

/**
 * The names, beyond the adapter's allowlist, passed to OpenSesame as they are:
 * the store passphrase (OpenSesame strips it from the command), where the store
 * is, and HOBO_CREDENTIALS itself, which the allowlist keeps back because its
 * name looks like a credential's. The relaunched hobo does not need it to refuse
 * a placeholder (the run's HOBO_OPENSESAME_CHILD=1 alone turns the guard on); it
 * is passed so the command runs in the mode its parent was started in, for
 * whatever reads HOBO_CREDENTIALS there. Fixed here, in operator code, never read
 * from the environment or a repository file: a list a checkout controls could
 * pass on what the allowlist keeps back.
 */
export const OPENSESAME_PASS_ENV = [
	"HOBO_CREDENTIALS",
	"OPENSESAME_STORE_PASSWORD",
	"OPENSESAME_STORE_DIR",
] as const;

const surrogateRe = new RegExp(SURROGATE_PATTERN, "u");

/**
 * Credentials that may not sit beside the surrogate: every provider's that the
 * executor already refuses as ambient (`AMBIENT_CREDENTIAL_KEYS`, @hobo/cloud),
 * and Vercel's other conventional name. In a process whose credentials come from
 * OpenSesame, one of them would pick a lane of its own (CLOUDFLARE_API_TOKEN
 * selects Cloudflare ahead of Vercel) or be spent outside OpenSesame. The run's
 * environment is built without them; one that is there came back some other way.
 */
export const CREDENTIALS_BESIDE_SURROGATE: readonly string[] = Object.freeze([
	...AMBIENT_CREDENTIAL_KEYS,
	"VERCEL_API_TOKEN",
]);

/** Where hobo's own `hobo:` lines and OpenSesame's stderr go. */
type Stderr = NonNullable<RunInput["stderr"]>;

export type OpenSesameCredentialsErrorCode =
	| "OPENSESAME_PLACEHOLDERS_ONLY"
	| "OPENSESAME_CREDENTIALS_BESIDE_SURROGATE"
	| "OPENSESAME_BINDINGS_UNREADABLE"
	| "OPENSESAME_NOT_RELAUNCHED"
	| "OPENSESAME_LANE_NOT_BROKERED";

export class OpenSesameCredentialsError extends Error {
	readonly code: OpenSesameCredentialsErrorCode;

	constructor(code: OpenSesameCredentialsErrorCode, message: string) {
		super(message);
		this.name = "OpenSesameCredentialsError";
		this.code = code;
	}
}

/** Whether this process should relaunch itself under OpenSesame: asked to, and not already its child. */
export function wantsOpenSesameRelaunch(env: NodeJS.ProcessEnv): boolean {
	return (
		env.HOBO_CREDENTIALS === OPENSESAME_CREDENTIALS && env[CHILD_MARKER] !== "1"
	);
}

const VERBS: ReadonlySet<string> = new Set(
	CANONICAL_VERBS.map((verb) => verb.name),
);

/**
 * Whether `args` run a verb, decided by the CLI's own parser and verb list. The
 * CLI answers help (`--help` or `-h`, with or without a verb, and no verb at
 * all), an unknown verb and a usage error (`hobo status`, `hobo --version`)
 * without running one, so none of them needs a credential, and under
 * HOBO_CREDENTIALS=opensesame they are answered without starting OpenSesame.
 */
export function runsAVerb(args: readonly string[]): boolean {
	let request: ReturnType<typeof parseArgv>;
	try {
		request = parseArgv(args);
	} catch {
		return false;
	}
	return request.verb !== null && !request.help && VERBS.has(request.verb);
}

/** An IaC adapter that refuses every call: nothing composed with it can deploy. */
const refusingAdapter: PulumiAutomationAdapter = Object.freeze({
	id: "opensesame-not-relaunched",
	preview: refuseUnrelaunched,
	apply: refuseUnrelaunched,
	destroy: refuseUnrelaunched,
	refresh: refuseUnrelaunched,
});

function refuseUnrelaunched(): never {
	throw new OpenSesameCredentialsError(
		"OPENSESAME_NOT_RELAUNCHED",
		`HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS}, but this invocation runs no verb, so it was not run under OpenSesame and holds no credential: nothing was deployed`,
	);
}

/**
 * What an invocation that runs no verb is composed with under
 * HOBO_CREDENTIALS=opensesame: no environment to take a credential from, and an
 * IaC adapter that refuses every call, so that a verb run on it all the same
 * (were `runsAVerb` ever to disagree with the CLI) fails rather than deploys
 * without OpenSesame.
 */
export function withoutCredentials(): DefaultYardRuntimeOptions {
	return { env: {}, iacAdapter: refusingAdapter };
}

/**
 * Whether this process takes its credentials from OpenSesame: asked to, or
 * started as a proxied run's command (HOBO_OPENSESAME_CHILD=1), which holds a
 * surrogate or a placeholder and never a token of its own.
 */
export function usesOpenSesameCredentials(env: NodeJS.ProcessEnv): boolean {
	return (
		env.HOBO_CREDENTIALS === OPENSESAME_CREDENTIALS || env[CHILD_MARKER] === "1"
	);
}

/**
 * Refuse to deploy on anything but the run's surrogate when credentials come
 * from OpenSesame: VERCEL_TOKEN must be one, and no other provider's credential
 * may be beside it (CREDENTIALS_BESIDE_SURROGATE; a surrogate-shaped value is not
 * one). Names are said, values never: a plain token exported by mistake would
 * otherwise be printed.
 */
export function requireOpenSesameSurrogate(env: NodeJS.ProcessEnv): void {
	const token = env.VERCEL_TOKEN;
	if (token === undefined || !surrogateRe.test(token)) {
		throw new OpenSesameCredentialsError(
			"OPENSESAME_PLACEHOLDERS_ONLY",
			`credentials come from OpenSesame (HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS}, or a proxied run's command), but VERCEL_TOKEN holds ${token === undefined || token === "" ? "nothing" : "a placeholder or a plain token"}, not an OpenSesame surrogate: nothing was deployed. Run hobo under OpenSesame (it relaunches itself when HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS}) with the surrogate-proxy plugin installed and on, and the token sealed with \`opensesame pass insert\``,
		);
	}
	const beside = CREDENTIALS_BESIDE_SURROGATE.filter((name) => {
		const value = env[name];
		return value !== undefined && value !== "" && !surrogateRe.test(value);
	});
	if (beside.length > 0) {
		throw new OpenSesameCredentialsError(
			"OPENSESAME_CREDENTIALS_BESIDE_SURROGATE",
			`credentials come from OpenSesame (HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS}, or a proxied run's command), but this process also holds ${beside.join(", ")}: a credential beside the surrogate would be used outside OpenSesame, so nothing was deployed. Unset ${beside.length === 1 ? "it" : "them"} where hobo is started, or leave HOBO_CREDENTIALS unset to deploy with ${beside.length === 1 ? "it" : "them"}`,
		);
	}
}

/**
 * Refuse the live Pulumi lane when credentials come from OpenSesame. Its engine
 * authenticates in process with whatever Pulumi and cloud credentials it finds
 * (PULUMI_ACCESS_TOKEN, an AWS profile, a config passphrase), which a surrogate
 * swapped at the proxy cannot stand for: OpenSesame brokers Vercel's bearer
 * token only (ADR-0170 decision 4, the reason AWS is `provider_not_brokered`).
 * There is no relaunch credential path to take it through, so a proxied run that
 * selects it is refused, with the variable named, before the lane is built.
 */
export function refuseUnbrokeredLane(env: NodeJS.ProcessEnv): void {
	if (!usesOpenSesameCredentials(env)) return;
	throw new OpenSesameCredentialsError(
		"OPENSESAME_LANE_NOT_BROKERED",
		`credentials come from OpenSesame (HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS}, or a proxied run's command), but HOBO_PULUMI_LIVE selects the live Pulumi lane, which OpenSesame does not broker: it would deploy with whatever credentials Pulumi finds outside OpenSesame, so nothing was deployed. Unset HOBO_PULUMI_LIVE, or leave HOBO_CREDENTIALS unset to use the live lane`,
	);
}

/**
 * Run the composed CLI, reporting a credential refusal as one `hobo:` line and
 * status 1 instead of a stack trace. The default runtime selects its deploy
 * backend when it is composed, so a run holding a placeholder is refused
 * before its verb runs: nothing in it can deploy. (Help and usage errors are
 * not relaunched, so they never meet this; see `runsAVerb`.)
 */
export async function reportingCredentialRefusals(
	run: () => Promise<number>,
	stderr: Stderr = process.stderr,
): Promise<number> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof OpenSesameCredentialsError)) throw error;
		stderr.write(`hobo: ${error.code}: ${error.message}\n`);
		return 1;
	}
}

export type RelaunchInput = Readonly<{
	/** The command to run under OpenSesame: this hobo invocation, `process.execPath` first. */
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
	/** Where `hobo.credentials.json` is read from. */
	cwd: string;
	/** The `opensesame` executable: a bare name is looked up on PATH. Defaults to `opensesame`. */
	bin?: string | undefined;
	/** Names passed to OpenSesame beyond the allowlist. Defaults to OPENSESAME_PASS_ENV; operator code only. */
	passEnv?: readonly string[] | undefined;
	stderr?: Stderr | undefined;
	tmpRoot?: string | undefined;
	/** Node options this process has that `argv` and `env` leave out, by name; said on stderr before the run. */
	leftOut?: readonly string[] | undefined;
}>;

/** What a relaunch is made from: this process. `process` is one. */
export type RelaunchedProcess = Readonly<{
	execPath: string;
	execArgv: readonly string[];
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
	cwd(): string;
}>;

/**
 * The relaunch of `proc`: the same Node, script and arguments, with only the
 * Node options that read no environment or code from disk, from its command line
 * and from NODE_OPTIONS (relaunch-node-options.ts). Passing `execArgv` on as it
 * was let `node --env-file=.env` re-read the file into the command, beside the
 * surrogate, after the adapter had kept those names back.
 */
export function relaunchInputFor(
	proc: RelaunchedProcess,
	bindingsDir: string = proc.cwd(),
): RelaunchInput {
	const options = nodeOptionsForRun({
		execArgv: proc.execArgv,
		nodeOptions: proc.env.NODE_OPTIONS,
		// Node resolves an --import from where it was started, whatever --cwd says.
		cwd: proc.cwd(),
	});
	const env: NodeJS.ProcessEnv = { ...proc.env };
	if (options.nodeOptions === undefined) delete env.NODE_OPTIONS;
	else env.NODE_OPTIONS = options.nodeOptions;
	return {
		argv: [proc.execPath, ...options.execArgv, ...proc.argv.slice(1)],
		env,
		cwd: bindingsDir,
		leftOut: options.left,
	};
}

/**
 * The directory a `hobo` invocation works in, as the CLI resolves it: its
 * `--cwd`, else `cwd`. `hobo --cwd app up` reads `app/hobo.credentials.json`,
 * the same project the verb then works on. An invocation the CLI cannot parse
 * runs no verb; for it this is `cwd`.
 */
export function workingDirOf(args: readonly string[], cwd: string): string {
	try {
		return parseArgv(args, { cwd }).cwd;
	} catch {
		return resolve(cwd);
	}
}

function readBindings(cwd: string): RunInput["bindings"] {
	const path = join(cwd, CREDENTIAL_BINDINGS_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		throw new OpenSesameCredentialsError(
			"OPENSESAME_BINDINGS_UNREADABLE",
			`HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS} needs ${path}: the connections and scopes to run under (references only, never a token) (${cause instanceof Error && "code" in cause ? String(cause.code) : "unreadable"})`,
		);
	}
	return parseCredentialBindings(parseJsonValue(text));
}

/**
 * Run this hobo invocation once more under OpenSesame and return the status to
 * exit with. A refusal before OpenSesame starts (no bindings, no trusted
 * `opensesame`, a real token already in the environment, this process already a
 * child) is printed and is status 1; a run that ended any other way than the
 * command's own exit is printed with its typed code.
 */
export async function relaunchUnderOpenSesame(
	input: RelaunchInput,
): Promise<number> {
	const stderr = input.stderr ?? process.stderr;
	const leftOut = input.leftOut ?? [];
	if (leftOut.length > 0) {
		stderr.write(
			`hobo: not passed to the run under OpenSesame: ${leftOut.join(", ")} (a Node option reaches it only when it reads no environment or code from disk)\n`,
		);
	}
	try {
		const outcome = await runProxied({
			bin: input.bin ?? "opensesame",
			bindings: readBindings(input.cwd),
			argv: input.argv,
			env: input.env,
			passEnv: input.passEnv ?? OPENSESAME_PASS_ENV,
			stderr,
			tmpRoot: input.tmpRoot,
		});
		const failure = outcomeError(outcome);
		// The command's own failure is already on stderr, in its own words.
		if (failure !== undefined && failure.code !== "child_exit") {
			stderr.write(`hobo: ${failure.code}: ${failure.message}\n`);
		}
		return exitCodeOf(outcome);
	} catch (error) {
		if (
			error instanceof OpenSesameAdapterError ||
			error instanceof OpenSesameCredentialsError
		) {
			stderr.write(`hobo: ${error.code}: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}

/**
 * `hobo-mcp`'s relaunch: the same as `hobo`'s, once the store passphrase is in
 * the environment. Its stdin is the MCP stream, and OpenSesame, given no
 * OPENSESAME_STORE_PASSWORD and no terminal on stdin, reads the passphrase as a
 * line of stdin (its `prompt_password`): the client's first message. So without
 * one it starts nothing, says so on one line, and is status 1.
 */
export async function relaunchMcpUnderOpenSesame(
	input: RelaunchInput,
): Promise<number> {
	const passphrase = input.env.OPENSESAME_STORE_PASSWORD;
	if (passphrase === undefined || passphrase === "") {
		(input.stderr ?? process.stderr).write(
			`hobo: OPENSESAME_STORE_PASSWORD_REQUIRED: hobo-mcp under HOBO_CREDENTIALS=${OPENSESAME_CREDENTIALS} needs OPENSESAME_STORE_PASSWORD in its environment, because its stdin carries the MCP stream and OpenSesame would read the store passphrase from it; nothing was started. Set it in the MCP server's environment, or leave HOBO_CREDENTIALS unset\n`,
		);
		return 1;
	}
	return relaunchUnderOpenSesame(input);
}
