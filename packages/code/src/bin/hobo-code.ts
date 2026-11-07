#!/usr/bin/env node
/**
 * hobo-code — standalone coding harness CLI (ADR-0139).
 * Default verb: dispatch.
 *
 * Bare `hobo-code` (or `hobo-code chat`) on a TTY opens the **HoBo-owned
 * InteractiveShell** (Bo + chat + slash + tasks/status) — NOT stock Pi Agent
 * chrome. Pi remains an optional engine only:
 *   HOBO_CODE_TUI=pi  or  hobo-code --pi
 *
 * Piped stdout, --json, or any other verb stays one-shot.
 *
 * Note: the separate `hobo` binary is the control-plane shell (up/dev/plan),
 * not this coding harness.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDING_SIGNALS } from "../../bin/ending-signals.mjs";
import { formatHoboCodeResult, runHoboCodeCli } from "../cli.js";
import { removeComposedDirsOnSignals } from "../composed-hobo.js";
import type { DevMachine } from "../dev-machines.js";
import { resolveShellEngine } from "../engine-resolve.js";
import { runGitTerminalPane } from "../git-terminal-pane.js";
import {
	HOBO_AGENT_INSTRUCTIONS,
	HOBO_AGENT_MODEL,
} from "../harness-customization.js";
import {
	runInteractiveShell,
	type ShellMessage,
} from "../interactive-shell.js";
import { cleanupIsolation, createIsolationContext } from "../isolation.js";
import { isJsonObject } from "../json.js";
import { hangUpWhenLauncherGoes } from "../launcher-hangup.js";
import { forwardResidentSessions } from "../session-forward.js";
import { serveSessionsLocally } from "../session-serve-local.js";
import type { ShellEngine } from "../shell-engine.js";
import { createDefaultShellHost } from "../shell-host.js";
import { isTerminalGone } from "../shell-terminal.js";
import { endingSignalHold, signalStatus } from "../signal-hold.js";
import { runResidentSshAgentProxy } from "../ssh-agent-proxy.js";

// This is the process's entry point: when a `/hobo` verb composes HoBo here,
// its `hobo-yard-*` store is removed on a signal too, not only on exit.
removeComposedDirsOnSignals();

// The launcher (bin/hobo-code.mjs) runs this process in a session of its own,
// with an IPC channel: a launcher killed outright is a hangup here.
hangUpWhenLauncherGoes();

const rawArgv = process.argv.slice(2);
const json = rawArgv.includes("--json");
const dense =
	rawArgv.includes("--dense") ||
	rawArgv.includes("-D") ||
	process.env.HOBO_CODE_DENSE === "1" ||
	process.env.HOBO_CODE_DENSE === "true";
const wantPiTui =
	rawArgv.includes("--pi") ||
	process.env.HOBO_CODE_TUI === "pi" ||
	process.env.HOBO_CODE_TUI === "pi-tui";
// Strip shell-only flags before CLI / chat detection
const argv = rawArgv.filter((a) => a !== "--pi");
const interactive =
	process.stdout.isTTY === true && process.stdin.isTTY === true;
const chatVerb = argv[0] === "chat";
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Legacy escape hatch: spawn stock Pi TUI with HoBo extension.
 * Not the product default — use only for engine experiments.
 */
async function launchProductShell(options: {
	readonly dense: boolean;
	readonly cwd?: string;
	readonly sessionId?: string;
	readonly messages?: readonly ShellMessage[];
	readonly journal?: readonly ShellMessage[];
}): Promise<number> {
	const hoboHome =
		process.env.HOBO_HOME && process.env.HOBO_HOME.length > 0
			? process.env.HOBO_HOME
			: join(process.env.HOME ?? tmpdir(), ".hobo");
	let engine: ShellEngine | null = null;
	const isolation = await createIsolationContext({
		projectRoot: options.cwd ?? process.cwd(),
		hoboHome,
	});
	const resolved = await resolveShellEngine({
		sandboxRoot: isolation.rootPath,
		runId: isolation.runId,
		modelSpec: HOBO_AGENT_MODEL,
		instructions: HOBO_AGENT_INSTRUCTIONS,
		env: process.env,
	});
	if (resolved.engine) {
		engine = resolved.engine;
	} else {
		await cleanupIsolation(isolation.runId, {
			hoboHome,
			ok: true,
			gates: ["engine:unavailable"],
		});
		process.stderr.write(
			`hobo-code: no completion engine — ${resolved.reason} (dispatch-only shell)\n`,
		);
	}
	const maxMs = Number.parseInt(process.env.HOBO_CODE_SHELL_MAX_MS ?? "", 10);
	const scriptedKeys = process.env.HOBO_CODE_SHELL_KEYS
		? process.env.HOBO_CODE_SHELL_KEYS.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\e/g, "\u001b")
		: undefined;
	const host = createDefaultShellHost({ dense: options.dense, engine });
	// A terminal that has gone (its window closed) fails every write after
	// it: what is written on the way out must not end hobo-code before the
	// host has closed what the shell holds.
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", (error: Error) => {
			if (!isTerminalGone(error)) throw error;
		});
	}
	let code: number;
	try {
		code = await runInteractiveShell({
			host,
			hoboHome,
			cwd: options.cwd ?? process.cwd(),
			dense: options.dense,
			reducedMotion:
				process.env.HOBO_CODE_REDUCED_MOTION === "1" ||
				process.env.HOBO_CODE_REDUCED_MOTION === "true",
			...(Number.isFinite(maxMs) && maxMs > 0 ? { maxMs } : undefined),
			...(scriptedKeys !== undefined ? { scriptedKeys } : undefined),
			...(options.sessionId !== undefined
				? { sessionId: options.sessionId }
				: undefined),
			...(options.messages !== undefined
				? { messages: options.messages }
				: undefined),
			...(options.journal !== undefined
				? { journal: options.journal }
				: undefined),
		});
	} finally {
		await host.dispose?.();
	}
	if (engine) {
		await engine.dispose();
		process.stdout.write(
			`sandbox kept: ${engine.sandboxRoot}\npromote (audited): hobo-code promote --run ${engine.runId}\n`,
		);
	}
	// A signal that came while a verb held a Station authorization (or the
	// terminal's hangup) ends the shell by that signal, now that dispose has
	// closed what was open.
	const signal = host.exitSignal?.();
	return signal !== undefined ? signalStatus(signal) : code;
}

function launchPiHarness(): Promise<number> {
	const piEntry = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	const piBin = join(dirname(piEntry), "cli.js");
	const args = [
		piBin,
		"--no-extensions",
		"-e",
		join(pkgRoot, "pi", "extensions", "hobo.ts"),
		"--append-system-prompt",
		HOBO_AGENT_INSTRUCTIONS,
	];
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal === "SIGINT") resolve(130);
			else resolve(code ?? 1);
		});
	});
}

if (argv[0] === "_station-agent") {
	try {
		process.exitCode = await runResidentSshAgentProxy(argv[1] ?? "");
	} catch (error) {
		process.stderr.write(
			`hobo-code: resident SSH agent failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
} else if (interactive && !json && (argv.length === 0 || chatVerb)) {
	if (wantPiTui) {
		process.stderr.write(
			"hobo-code: HOBO_CODE_TUI=pi / --pi — launching stock Pi TUI (escape hatch; not product default)\n",
		);
		process.exitCode = await launchPiHarness();
	} else {
		process.exitCode = await launchProductShell({ dense });
	}
} else {
	// `session serve --host` and `mux --host` open a Station authorization.
	// The ending signals are held from just before it is opened until what was
	// opened is closed or handed over (the forward below closes its own), so
	// that none ends hobo-code with it open (src/signal-hold.ts).
	const signals = endingSignalHold();
	const result = await runHoboCodeCli(argv, { json, dense, signals });
	process.stdout.write(formatHoboCodeResult(result, { json, dense }));
	const action =
		result.data && isJsonObject(result.data)
			? // SAFETY: parsed or fixture value is the named domain type after this assertion.
				(
					result.data as {
						readonly terminalAction?: {
							readonly kind?: string;
							readonly sessionName?: string;
							readonly sessionId?: string;
							readonly messages?: readonly ShellMessage[];
							readonly journal?: readonly ShellMessage[];
							readonly cwd?: string;
							readonly hoboHome?: string;
							readonly projectRoot?: string;
							readonly machine?: DevMachine;
							readonly port?: number;
							readonly authorizationSessionId?: string;
							readonly authorizationExpiresAt?: string;
							readonly auditTypes?: readonly string[];
							readonly credentialMode?: "station-authorized-agent";
							readonly identityAgent: string;
							readonly closeAuthorization?: (reason?: string) => Promise<void>;
						};
					}
				).terminalAction
			: undefined;
	if (
		result.ok &&
		action?.kind === "resume-chat" &&
		action.sessionId &&
		interactive &&
		!json
	) {
		process.exitCode = await launchProductShell({
			dense,
			sessionId: action.sessionId,
			...(action.messages !== undefined
				? { messages: action.messages }
				: undefined),
			...(action.journal !== undefined
				? { journal: action.journal }
				: undefined),
			...(action.cwd !== undefined ? { cwd: action.cwd } : undefined),
		});
	} else if (
		result.ok &&
		action?.kind === "attach-session" &&
		action.sessionName
	) {
		const args = process.env.TMUX
			? ["switch-client", "-t", action.sessionName]
			: ["attach-session", "-t", action.sessionName];
		process.exitCode = await new Promise<number>((resolve) => {
			const child = spawn("tmux", args, { stdio: "inherit" });
			child.once("error", () => resolve(1));
			child.once("exit", (code, signal) =>
				resolve(signal === "SIGINT" ? 130 : (code ?? 1)),
			);
		});
	} else if (result.ok && action?.kind === "git-pane" && action.sessionId) {
		process.exitCode = await runGitTerminalPane({
			sessionId: action.sessionId,
			hoboHome:
				action.hoboHome ??
				(process.env.HOBO_HOME && process.env.HOBO_HOME.length > 0
					? process.env.HOBO_HOME
					: join(process.env.HOME ?? tmpdir(), ".hobo")),
		});
	} else if (
		result.ok &&
		action?.kind === "detach-session" &&
		process.env.TMUX
	) {
		process.exitCode = await new Promise<number>((resolve) => {
			const child = spawn("tmux", ["detach-client"], { stdio: "inherit" });
			child.once("error", () => resolve(1));
			child.once("exit", (code) => resolve(code ?? 1));
		});
	} else if (
		result.ok &&
		action?.kind === "forward-sessions" &&
		action.machine &&
		action.port
	) {
		try {
			process.exitCode = await forwardResidentSessions(
				{
					machine: action.machine,
					port: action.port,
					identityAgent: action.identityAgent,
					...(action.authorizationSessionId !== undefined
						? { authorizationSessionId: action.authorizationSessionId }
						: undefined),
					...(action.authorizationExpiresAt !== undefined
						? { authorizationExpiresAt: action.authorizationExpiresAt }
						: undefined),
					...(action.auditTypes !== undefined
						? { auditTypes: action.auditTypes }
						: undefined),
				},
				signals,
			);
		} finally {
			await action.closeAuthorization?.(signals.first ?? "forward-ended");
			signals.release();
		}
	} else if (result.ok && action?.kind === "serve-sessions") {
		const served = await serveSessionsLocally({
			...(action.hoboHome !== undefined
				? { hoboHome: action.hoboHome }
				: undefined),
			...(action.projectRoot !== undefined
				? { projectRoot: action.projectRoot }
				: undefined),
			...(action.port !== undefined ? { port: action.port } : undefined),
		});
		// Any signal that ends hobo-code stops the server the same way: the
		// launcher passes SIGHUP (a closing terminal) and SIGQUIT on too, and
		// either one, unhandled, ended the process with the server unclosed.
		// Listen before saying where the server is, so a signal sent once the
		// address is out reaches the close.
		const stopped = new Promise<void>((resolve) => {
			for (const signal of ENDING_SIGNALS)
				process.once(signal, () => resolve());
		});
		process.stdout.write(served.banner);
		await stopped;
		await served.close();
		process.exitCode = 0;
	} else {
		process.exitCode = result.exitCode;
	}
	// A signal held while the authorization was opened, which then went
	// unused (the CLI failed after opening it, and closed it), or one that
	// came while the forward's authorization was closing: it ends
	// hobo-code now, as it would have, with the authorization closed.
	// A forward already ended by that signal returned this same status.
	if (signals.first !== undefined) {
		process.exitCode = signalStatus(signals.first);
	}
	signals.release();
}
