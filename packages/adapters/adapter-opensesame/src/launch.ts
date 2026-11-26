/**
 * Launching a command under OpenSesame, so it holds `osr_` surrogates and never
 * a token: `opensesame dev --agent --schema <file> run -- <cmd...>` with the
 * `.env.schema` this adapter rendered from reference-only bindings.
 *
 * `buildLaunch` is pure: it checks what must hold before anything starts (this
 * process is not itself such a child, this Node can send `fetch` through
 * `HTTPS_PROXY`, the env-spec bridge named by OPENSESAME_ENV_PARSE is an absolute
 * path to a file in a trusted place (`bridge.ts`), no
 * real credential for a bound provider is already in the environment) and
 * returns the argv and the environment it builds: an allowlist plus `passEnv`
 * (`child-env.ts`), not the caller's. `runProxied` finds and identifies the
 * `opensesame` (`opensesame-bin.ts`), writes the schema 0600 in a directory of its
 * own, runs it, passes the signals it is sent on to OpenSesame, reads how it
 * ended, and removes the schema when the run ends, throws, or is interrupted.
 * `supervise.ts` says what that covers and what it cannot (SIGKILL, a crash).
 *
 * The store passphrase is never read or set here. OpenSesame takes it from the
 * terminal, or from OPENSESAME_STORE_PASSWORD when the caller lists that name in
 * `passEnv`, and only after `--version` has identified the executable; it strips
 * the passphrase from the command itself.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProxiedRunOutcome } from "./_generated/adapter_opensesame_pb.js";
import type { ParsedCredentialBinding } from "./binding.js";
import { checkBridge } from "./bridge.js";
import { createCapture } from "./capture.js";
import { childEnvOf } from "./child-env.js";
import { OpenSesameAdapterError } from "./errors.js";
import { Launch } from "./launch-value.js";
import { type BinProbe, trustedOpenSesame } from "./opensesame-bin.js";
import { createOutcomeScan, parseOutcome } from "./outcome.js";
import { CHILD_MARKER } from "./run-markers.js";
import { renderEnvSchema } from "./schema.js";
import {
	guardRun,
	type SignalSource,
	type SpawnedProcess,
} from "./supervise.js";
import { nodeTrust, type Trust } from "./trust.js";

export type { Launch } from "./launch-value.js";
export type { SignalSource, SpawnedProcess } from "./supervise.js";

const CAPTURE_LIMIT = 64 * 1024;
const STDERR_GRACE_MS = 1000;

export type LaunchInput = Readonly<{
	/** The `opensesame` executable. */
	bin: string;
	/** The generated `.env.schema`. */
	schemaPath: string;
	/** The command to run under it. */
	argv: readonly string[];
	/** The credentials the run brokers: the variables a surrogate goes in, and the providers whose real tokens must not be in `env`. */
	bindings: readonly ParsedCredentialBinding[];
	/** The caller's environment. Only the allowlist in `child-env.ts` and `passEnv` are passed on. */
	env: NodeJS.ProcessEnv;
	/** Variable names, beyond the allowlist, to pass on as they are (the store passphrase, OPENSESAME_STORE_DIR, ...). Operator code supplies this, never a repository file, the environment or a model. */
	passEnv?: readonly string[] | undefined;
	/** The platform whose variables are kept. Defaults to this process's. */
	platform?: NodeJS.Platform | undefined;
	/** What PATH entries are checked against (the user, the file system, the working directory). Defaults to this process's. */
	trust?: Trust | undefined;
	/** Node's version, for the `fetch` proxy check. Defaults to this process's. */
	nodeVersion?: string | undefined;
}>;

function hasNul(text: string): boolean {
	return text.includes("\0");
}

/** `NODE_USE_ENV_PROXY` exists from v22.21.0 and v24.0.0. */
function nodeProxiesFetch(version: string): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major >= 24 || (major === 22 && minor >= 21);
}

export function buildLaunch(input: LaunchInput): Launch {
	if (input.env[CHILD_MARKER] === "1") {
		throw new OpenSesameAdapterError(
			"recursion_guard",
			"this process already runs under OpenSesame; it will not start another proxied run",
		);
	}
	if (input.argv.length === 0) {
		throw new OpenSesameAdapterError(
			"launch_invalid",
			"a proxied run needs a command",
		);
	}
	if ([input.bin, input.schemaPath, ...input.argv].some(hasNul)) {
		throw new OpenSesameAdapterError(
			"launch_invalid",
			"the command, the executable and the schema path cannot hold a NUL byte",
		);
	}
	if (!nodeProxiesFetch(input.nodeVersion ?? process.versions.node)) {
		throw new OpenSesameAdapterError(
			"node_proxy_unsupported",
			"this Node cannot send fetch through HTTPS_PROXY (NODE_USE_ENV_PROXY needs 22.21 or 24): without it fetch ignores HTTPS_PROXY and dials the provider directly with a surrogate only the proxy can redeem",
		);
	}
	const trust = input.trust ?? nodeTrust();
	const platform = input.platform ?? process.platform;
	checkBridge({
		env: input.env,
		platform,
		trust,
	});
	return new Launch({
		command: input.bin,
		args: Object.freeze([
			"dev",
			"--agent",
			"--schema",
			input.schemaPath,
			"run",
			"--",
			...input.argv,
		]),
		env: Object.freeze({
			...childEnvOf({
				env: input.env,
				passEnv: input.passEnv ?? [],
				bindings: input.bindings,
				platform,
				trust,
			}),
			NODE_USE_ENV_PROXY: "1",
			[CHILD_MARKER]: "1",
		}),
	});
}

export type SpawnFn = (
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
) => SpawnedProcess;

export interface StderrSink {
	write(chunk: string): void;
}

export type RunInput = Readonly<{
	bin: string;
	bindings: readonly ParsedCredentialBinding[];
	argv: readonly string[];
	env?: NodeJS.ProcessEnv;
	passEnv?: readonly string[] | undefined;
	platform?: NodeJS.Platform | undefined;
	/** What PATH entries and the `opensesame` file are checked against. Defaults to this process's user, file system and working directory. */
	trust?: Trust | undefined;
	spawn?: SpawnFn;
	signals?: SignalSource;
	stderr?: StderrSink;
	nodeVersion?: string | undefined;
	tmpRoot?: string | undefined;
	/** Runs `opensesame --version` for the identity check. Defaults to doing so. */
	probe?: BinProbe | undefined;
	/** How long after OpenSesame exits its stderr is still read, in ms. Defaults to 1000. */
	stderrGraceMs?: number | undefined;
	/** Removes the schema directory. Defaults to a recursive, forced removal; a seam for tests. */
	remove?: ((dir: string) => Promise<void>) | undefined;
	/**
	 * Re-raises SIGINT or SIGQUIT after the run is cleaned up. Defaults to doing
	 * so on this process, and to nothing when `signals` is injected.
	 */
	raise?: ((signal: NodeJS.Signals) => void) | undefined;
}>;

/** Stdin and stdout are the person's; stderr is read as well as shown. */
const nodeSpawn: SpawnFn = (command, args, env) =>
	spawn(command, [...args], { env, stdio: ["inherit", "inherit", "pipe"] });

/**
 * Wait for OpenSesame to end and read its stderr. `close` (the stderr pipe is
 * closed) is the usual end, but a descendant that inherited the pipe, such as a
 * daemon the command started, holds it open after OpenSesame has gone, so the
 * read ends `graceMs` after `exit` whether or not the pipe has: the run is
 * already over and revoked, and a hang would keep the handlers installed.
 */
function wait(
	child: SpawnedProcess,
	sink: StderrSink,
	graceMs: number,
): Promise<ProxiedRunOutcome> {
	return new Promise((resolve, reject) => {
		const capture = createCapture(CAPTURE_LIMIT);
		// Sees every chunk, so what a descendant writes after OpenSesame's last line cannot push that line out of the capture.
		const scan = createOutcomeScan();
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const settle = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(parseOutcome(code, signal, capture.text(), scan.sentences()));
		};
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk);
			sink.write(text);
			capture.push(text);
			scan.push(text);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new OpenSesameAdapterError(
					"opensesame_bin_missing",
					`the opensesame executable could not be started (${"code" in error ? String(error.code) : "error"})`,
				),
			);
		});
		child.on("exit", (code, signal) => {
			timer = setTimeout(() => {
				child.stderr?.destroy?.();
				settle(code, signal);
			}, graceMs);
		});
		child.on("close", settle);
	});
}

function removeDir(dir: string): Promise<void> {
	return rm(dir, { recursive: true, force: true });
}

/** Re-raise an interrupt on this process, once the run is cleaned up, so its default action applies. */
function raiseOnProcess(signal: NodeJS.Signals): void {
	process.kill(process.pid, signal);
}

/**
 * Run `argv` under OpenSesame with `bindings` and say how it ended. Nothing is
 * started unless the launch is valid, OpenSesame is found and identified, and no
 * signal has arrived. The schema is removed when the run ends, throws, or is
 * ended by SIGTERM, SIGHUP, SIGINT or SIGQUIT, and from the process's `exit`
 * event; `supervise.ts` says what that cannot cover (SIGKILL, a crash).
 */
export async function runProxied(input: RunInput): Promise<ProxiedRunOutcome> {
	const env = input.env ?? process.env;
	const trust = input.trust ?? nodeTrust();
	const checks = {
		bin: input.bin,
		argv: input.argv,
		bindings: input.bindings,
		env,
		passEnv: input.passEnv,
		platform: input.platform,
		trust,
		nodeVersion: input.nodeVersion,
	};
	// Refuse before anything is written: a launch that cannot happen leaves no schema.
	buildLaunch({ ...checks, schemaPath: "" });
	// Found, checked and identified before the passphrase can reach it.
	const bin = trustedOpenSesame({
		bin: input.bin,
		env,
		probe: input.probe,
		trust,
		platform: input.platform,
	});
	// Guarded from here, before the first await, to the schema's removal.
	const guard = guardRun(
		input.signals ?? process,
		input.raise ?? (input.signals === undefined ? raiseOnProcess : undefined),
	);
	// Absolute now: a chdir during the run must not move where the schema is, or where it is removed from.
	const root = resolve(input.tmpRoot ?? tmpdir());
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(root, "hobo-opensesame-"));
		guard.own(dir);
		const schemaPath = join(dir, ".env.schema");
		const launch = buildLaunch({ ...checks, bin, schemaPath });
		await writeFile(schemaPath, renderEnvSchema(input.bindings), {
			mode: 0o600,
			flag: "wx",
		});
		const interrupted = guard.received();
		if (interrupted !== undefined) {
			throw new OpenSesameAdapterError(
				"signalled",
				`${interrupted} arrived before OpenSesame was started; nothing was started`,
			);
		}
		const child = (input.spawn ?? nodeSpawn)(
			launch.command,
			launch.args,
			launch.env,
		);
		guard.attach(child);
		return await wait(
			child,
			input.stderr ?? process.stderr,
			input.stderrGraceMs ?? STDERR_GRACE_MS,
		);
	} finally {
		guard.detach();
		try {
			if (dir !== undefined) await (input.remove ?? removeDir)(dir);
		} catch {
			// The directory holds references only. A failed removal is not the run's error, and must not
			// replace the one that ended it; the temp directory's own cleanup takes it.
		} finally {
			guard.release();
		}
	}
}
