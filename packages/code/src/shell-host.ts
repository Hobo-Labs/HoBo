/**
 * Default InteractiveShell host — bridges product CLI + dispatch + engine.
 *
 * Honesty contract (render-budget/honesty tests pin this):
 * - a chat reply states exactly what happened — without an engine, a turn
 *   *records a compute task* and the reply says so; with an engine, the turn
 *   streams the real model and edits stay in the mediated sandbox until an
 *   audited promote (ADR-0139);
 * - no success theater, no fixed "Next:" filler, no branding in replies;
 * - every reply teaches the equivalent one-shot command.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { type Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { sanitizeDisplay, stripAnsi } from "./ansi.js";
import { emitFromAtoms } from "./atom-index.js";
import {
	formatHoboCodeResult,
	type HoboCodeCliDeps,
	type HoboCodeCliResult,
	panel,
	runHoboCodeCli,
} from "./cli.js";
import { redactOutput } from "./command-redaction.js";
import { explicitHoboBinOverride, runComposedHobo } from "./composed-hobo.js";
import { type DevBrowserSession, resolveHoboSpawn } from "./dev-browser.js";
import { materializeExample } from "./example-catalog.js";
import { linkGeneratedAppRuntime } from "./generated-app-runtime.js";
import type { PendingApproval, ShellHost } from "./interactive-shell.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./json.js";
import {
	forwardBanner,
	forwardResidentSessions,
	type SessionForward,
} from "./session-forward.js";
import {
	type ServedSessions,
	type ServeSessionsAction,
	serveSessionsLocally,
} from "./session-serve-local.js";
import { formatUsage, type ShellEngine } from "./shell-engine.js";
import { endingSignalHold } from "./signal-hold.js";
import {
	formatLiveEndpoints,
	matchWorkspaceAction,
	resolveRunnableProject,
} from "./workspace-actions.js";

interface DispatchedTaskView {
	readonly taskId?: string;
	readonly status?: string;
	readonly handbackPath?: string;
	readonly error?: string;
}

function formatSessionCreateReply(options: {
	readonly id: string;
	readonly outputDir: string;
	readonly files: readonly string[];
	readonly holes: readonly string[];
}): string {
	const preview = [...options.files]
		.filter((file) => !file.endsWith(".gitkeep"))
		.sort((left, right) => {
			const rank = (file: string): number => {
				if (/(?:^|\/)(?:bindle|yard)\.ts$/u.test(file)) return 0;
				if (file.startsWith("src/")) return 1;
				return 2;
			};
			return rank(left) - rank(right);
		})
		.slice(0, 8)
		.join(", ");
	const hole =
		options.holes.length > 0
			? `Trainable holes (${options.holes.join(", ")}) are "use training" skeletons — not invented logic.`
			: undefined;
	return [
		`Created ${options.id} at ${options.outputDir}.`,
		preview.length > 0 ? `Wrote ${preview}.` : undefined,
		hole,
		'Say "run it" or "debug it" when you want live endpoints.',
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function dispatchedTask(result: HoboCodeCliResult): DispatchedTaskView | null {
	if (!isJsonObject(result.data) || result.data === null) return null;
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	const task = (result.data as { readonly task?: unknown }).task;
	if (!isJsonObject(task) || task === null) return null;
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	return task as DispatchedTaskView;
}

function oneShotHint(prompt: string): string {
	const compact = prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt;
	return `One-shot equivalent: hobo-code "${compact.replace(/"/g, '\\"')}"`;
}

async function runHoboCommand(
	argv: readonly string[],
	deps: DefaultShellHostOptions,
): Promise<string> {
	const env = { ...process.env, ...deps.env };
	const override = explicitHoboBinOverride(env);
	if (override === undefined) {
		const result = await runComposedHobo(argv, {
			cwd: deps.cwd ?? process.cwd(),
			env,
		});
		const text = [result.progress.join("\n"), result.stdout, result.stderr]
			.filter((part) => part.trim().length > 0)
			.join("\n")
			.trimEnd();
		if (result.exitCode === 0) {
			return text || `hobo ${argv.join(" ")} completed`;
		}
		throw new Error(
			`${text ? `${text}\n` : ""}hobo exited with ${result.exitCode}`,
		);
	}
	const spawned = resolveHoboSpawn({ env, argv, hoboBin: override });
	return new Promise((resolve, reject) => {
		const child = spawn(spawned.command, [...spawned.args], {
			cwd: deps.cwd ?? process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const append = (chunk: Buffer): void => {
			output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				reject(
					new Error(
						`hobo override binary not found (${err.path ?? spawned.bin}). Set HOBO_CODE_HOBO_BIN to a real composed binary, or unset it to use in-process @hobo/hobo`,
					),
				);
				return;
			}
			reject(error);
		});
		child.once("exit", (code, signal) => {
			const text = output.trimEnd();
			if (code === 0) resolve(text || `hobo ${argv.join(" ")} completed`);
			else
				reject(
					new Error(
						`${text ? `${text}\n` : ""}hobo exited with ${signal ?? code ?? "unknown status"}`,
					),
				);
		});
	});
}

/** A forward-sessions action the CLI handed over, with the authorization it holds. */
interface HandedForward extends SessionForward {
	readonly closeAuthorization?: (reason?: string) => Promise<void>;
}

/**
 * The reason recorded on `pam.SessionEnded` when the shell closes a Station
 * authorization because it is quitting: on its own quit, or on an ending
 * signal while one of its verbs held the authorization.
 */
const SHELL_QUIT = "shell-quit";

/** The CLI's serve-sessions action, which the shell runs itself. */
function servedAction(
	result: HoboCodeCliResult,
): ServeSessionsAction | undefined {
	if (!result.ok || !result.data || !isJsonObject(result.data))
		return undefined;
	const action = result.data.terminalAction;
	if (!isJsonObject(action) || action.kind !== "serve-sessions")
		return undefined;
	return {
		...(isJsonString(action.hoboHome)
			? { hoboHome: action.hoboHome }
			: undefined),
		...(isJsonString(action.projectRoot)
			? { projectRoot: action.projectRoot }
			: undefined),
		...(isJsonNumber(action.port) ? { port: action.port } : undefined),
	};
}

function handedForward(result: HoboCodeCliResult): HandedForward | undefined {
	if (!result.ok || !result.data || !isJsonObject(result.data))
		return undefined;
	// SAFETY: runHoboCodeCli puts the forward-sessions action, with its closeAuthorization function, here.
	const action = (result.data as { readonly terminalAction?: unknown })
		.terminalAction as Partial<HandedForward> & { readonly kind?: string };
	if (
		action?.kind !== "forward-sessions" ||
		action.machine === undefined ||
		action.port === undefined ||
		action.identityAgent === undefined
	) {
		return undefined;
	}
	return {
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
		...(action.closeAuthorization !== undefined
			? { closeAuthorization: action.closeAuthorization }
			: undefined),
	};
}

/** The watchdog the shell runs its forward's ssh under (see startShellForward). */
const SSH_WATCHDOG = fileURLToPath(
	new URL("../bin/ssh-watchdog.mjs", import.meta.url),
);

/** The last line a stream wrote: `read` it, and `last` waits for its end. */
interface LastLine {
	read(stream: Readable | null): void;
	last(): Promise<string | undefined>;
}

function lastLineOf(): LastLine {
	let last: string | undefined;
	let partial = "";
	let closed: Promise<void> = Promise.resolve();
	const take = (line: string): void => {
		if (line.trim().length > 0) last = line;
	};
	return {
		read(stream) {
			if (stream === null) return;
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				const lines = `${partial}${chunk}`.split(/\r?\n/u);
				// A line with no end yet; bounded, as ssh's output is not ours.
				partial = (lines.pop() ?? "").slice(-4096);
				for (const line of lines) take(line);
			});
			closed = new Promise((resolve) => {
				stream.once("close", () => resolve());
			});
		},
		async last() {
			await closed;
			take(partial);
			return last;
		},
	};
}

/**
 * What the shell is told when its forward ends while it stays: why, ssh's
 * last line (its escapes dropped, its control characters made printable, and
 * passed through the package's redaction, never raw), and whether the
 * authorization is closed.
 */
function forwardEndNotice(
	forward: SessionForward,
	status: number,
	sshSaid: string | undefined,
	closeFailure: Error | undefined,
): string {
	const leaseOver =
		status === 124 ||
		Date.parse(forward.authorizationExpiresAt ?? "") <= Date.now();
	const why = leaseOver
		? "the Station authorization's lease ran out"
		: status === 0
			? "ssh ended"
			: `ssh exited with ${status}`;
	const scrub = (text: string): string =>
		redactOutput(sanitizeDisplay(stripAnsi(text)).trim(), 240).text;
	return panel(
		`${status === 0 && !leaseOver ? "◎" : "✕"} forward · ${forward.machine.id}`,
		[
			why,
			...(sshSaid !== undefined ? [`ssh: ${scrub(sshSaid)}`] : []),
			closeFailure !== undefined
				? `closing the Station authorization failed: ${scrub(closeFailure.message)}`
				: "the Station authorization is closed",
		],
	);
}

/** A forward the shell runs behind its screen; `stop` ends it and closes its authorization. */
interface ShellForward {
	stop(): Promise<void>;
}

/**
 * Run a forward the way the hobo-code bin does (`forwardResidentSessions`),
 * behind the shell's screen: ssh gets no terminal, and the forward hears
 * signals only from `stop`, the shell's own quit, while the shell keeps the
 * process's. However the forward ends (ssh exits, the lease runs out, the
 * forward fails to start, or `stop`), its authorization is closed.
 *
 * ssh runs in a process group of its own. In hobo-code's, the launcher's
 * signal reached ssh as it reached the shell, and Node could hand the shell
 * ssh's exit before the signal: the forward closed the authorization as if
 * ssh had ended by itself, before the shell knew it was quitting. Now only
 * the shell's quit stops ssh, and the close says why.
 *
 * Detached, ssh would outlive a shell that never got to quit. It runs under
 * a watchdog (`bin/ssh-watchdog.mjs`) whose stdin is a pipe this process
 * holds: however the process ends, SIGKILL included, the pipe ends and the
 * watchdog ends ssh; it ends ssh at the authorization's lease too. The
 * process's `exit`, which an uncaught error reaches as well, stops the
 * watchdog at once. Nothing asynchronous can run there, nor after SIGKILL,
 * so neither can close the authorization: its lease ends it.
 */
function startShellForward(
	forward: HandedForward,
	env: NodeJS.ProcessEnv,
	closingReason: () => string | undefined,
	notice: (text: string) => void,
	ended: () => void,
): ShellForward {
	const own = new EventEmitter();
	const signals = endingSignalHold({
		on: (signal, listener) => {
			own.on(signal, listener);
		},
		off: (signal, listener) => {
			own.off(signal, listener);
		},
	});
	let ssh: ChildProcess | undefined;
	const stopSshOnExit = (): void => {
		const pid = ssh?.pid;
		if (pid === undefined || ssh?.exitCode !== null || ssh.signalCode !== null)
			return;
		try {
			process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
		} catch {
			// Gone already.
		}
	};
	process.on("exit", stopSshOnExit);
	const stderr = lastLineOf();
	const done = forwardResidentSessions(forward, signals, {
		stdout: new Writable({ write: (_chunk, _encoding, next) => next() }),
		startSsh: (args) => {
			ssh =
				process.platform === "win32"
					? spawn("ssh", [...args], {
							stdio: ["ignore", "ignore", "pipe"],
							env,
						})
					: spawn(
							process.execPath,
							[
								SSH_WATCHDOG,
								String(Date.parse(forward.authorizationExpiresAt ?? "")),
								"ssh",
								...args,
							],
							// The watchdog's stdin: the pipe whose end is this process's.
							// Its stderr is ssh's, kept for the shell's notice.
							{ stdio: ["pipe", "ignore", "pipe"], env, detached: true },
						);
			stderr.read(ssh.stderr);
			return ssh;
		},
	})
		.catch(() => 1)
		.then(async (status) => {
			const reason = closingReason();
			let closeFailure: Error | undefined;
			try {
				await forward.closeAuthorization?.(reason);
			} catch (error) {
				closeFailure =
					error instanceof Error ? error : new Error(String(error));
			} finally {
				process.removeListener("exit", stopSshOnExit);
				signals.release();
				ended();
			}
			// Ended while the shell stays: ssh refused, ssh ended, or the lease
			// ran out. The shell's quit, which stopped it, says nothing.
			if (reason === undefined) {
				notice(
					forwardEndNotice(forward, status, await stderr.last(), closeFailure),
				);
			}
			if (closeFailure !== undefined) throw closeFailure;
		});
	return {
		async stop() {
			own.emit("SIGTERM", "SIGTERM");
			await done;
		},
	};
}

async function executeResidentTerminalAction(
	result: HoboCodeCliResult,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const action =
		result.data && isJsonObject(result.data)
			? // SAFETY: parsed or fixture value is the named domain type after this assertion.
				(
					result.data as {
						readonly terminalAction?: {
							readonly kind?: string;
							readonly sessionName?: string;
						};
					}
				).terminalAction
			: undefined;
	if (!result.ok) return;
	const args =
		action?.kind === "attach-session" && action.sessionName
			? env.TMUX
				? ["switch-client", "-t", action.sessionName]
				: ["attach-session", "-t", action.sessionName]
			: action?.kind === "detach-session" && env.TMUX
				? ["detach-client"]
				: undefined;
	if (!args) return;
	const code = await new Promise<number>((resolve) => {
		const child = spawn("tmux", args, { stdio: "inherit", env });
		child.once("error", () => resolve(1));
		child.once("exit", (exitCode, signal) =>
			resolve(signal === "SIGINT" ? 130 : (exitCode ?? 1)),
		);
	});
	if (code !== 0)
		throw new Error(`tmux ${args[0]} failed with exit code ${code}`);
}

export interface DefaultShellHostOptions extends HoboCodeCliDeps {
	/** Wired completion engine (Slice 2). Absent → honest dispatch-only mode. */
	readonly engine?: ShellEngine | null;
}

export function createDefaultShellHost(
	deps: DefaultShellHostOptions = {},
): ShellHost {
	const engine = deps.engine ?? null;
	const workspaceRoot = deps.cwd ?? process.cwd();
	let lastProjectDir: string | undefined;
	const devSessions = new Set<DevBrowserSession>();
	const forwards = new Set<ShellForward>();
	/** The shell, listening for what its forwards say when they end (onNotice). */
	const noticeListeners = new Set<(text: string) => void>();
	const notice = (text: string): void => {
		for (const listener of noticeListeners) listener(text);
	};
	const servedSessions = new Set<ServedSessions>();
	let disposed = false;
	// The process's ending signals, held from just before a verb opens a
	// Station authorization (the CLI asks, `signals.hold()`), as the hobo-code
	// entry holds them: the shell still quits on one, its dispose then closes
	// what was open, and the shell ends by that signal (`exitSignal`).
	const signals = endingSignalHold();
	/**
	 * Verbs that have opened, or are opening, an authorization they have not
	 * yet handed on: each settles when its verb returns. The shell's dispose waits
	 * for them, so a verb in flight closes what it opened before the shell ends.
	 */
	const authorizing = new Set<Promise<void>>();
	let endedBy: NodeJS.Signals | undefined;
	let watching = false;
	const holdForVerb = (): void => {
		signals.hold();
		if (watching) return;
		watching = true;
		signals.whileHeld((signal) => {
			if (authorizing.size > 0 || forwards.size > 0) endedBy ??= signal;
		});
	};
	const releaseSignals = (): void => {
		signals.release();
		watching = false;
	};
	const closingReason = (): string | undefined =>
		disposed || endedBy !== undefined ? SHELL_QUIT : undefined;
	const cliDeps: DefaultShellHostOptions = {
		...deps,
		onDevSession: (session) => {
			devSessions.add(session);
			deps.onDevSession?.(session);
		},
	};
	const engineExtras: Partial<ShellHost> = engine
		? {
				engineLabel: `${engine.id} · ${engine.modelLabel}`,
				aboutLines: [
					`Engine: ${engine.id} (${engine.modelLabel}) — streams real turns.`,
					`Sandbox: ${engine.sandboxRoot} (mediated; canonical tree read-only).`,
					"Edits never reach the canonical tree without an explicit approval;",
					`promotion is squash-only, gated and audited (run ${engine.runId}).`,
					"Pi TUI stays an opt-in escape hatch via `hobo-code --pi` — never the product UI.",
				],
				usageLabel: () => {
					const u = engine.usage();
					return u.totalTokens > 0 || u.costUsd > 0 ? formatUsage(u) : "";
				},
				streamTurn: (prompt, onEvent) => engine.turn(prompt, onEvent),
				cancelTurn: () => engine.abort(),
				/**
				 * Raise the approval gate only when the sandbox actually changed —
				 * an answer-only turn must not nag for a promotion.
				 */
				pendingApprovalFor: async (result) => {
					if (result.toolCalls === 0) return null;
					const changes = await engine.changes();
					if (changes.length === 0) return null;
					return {
						runId: engine.runId,
						sandboxRoot: engine.sandboxRoot,
						changes,
					};
				},
				promote: async (approval: PendingApproval) => {
					const result = await runHoboCodeCli(
						["promote", "--run", approval.runId],
						{ ...deps, json: false },
					);
					const body = formatHoboCodeResult(result, {
						json: false,
						dense: deps.dense === true,
					}).trimEnd();
					if (result.ok) {
						return [
							`Promoted run ${approval.runId} — gates ran, then the diff was applied.`,
							// The result's own message carries the applied count; the
							// approval snapshot can be stale by now.
							result.message,
							body,
						].join("\n");
					}
					return [
						`Promotion refused (${result.code}) — work stays in the sandbox.`,
						body,
						...(result.remediation?.length
							? ["Try:", ...result.remediation.map((r) => `  ${r}`)]
							: []),
					].join("\n");
				},
			}
		: {};
	/**
	 * `/sessions serve` without `--host`: start the session browser as
	 * `hobo-code session serve` does, say where it is, and close it with the
	 * shell (`dispose`), however the shell ends.
	 */
	const serveLocally = async (action: ServeSessionsAction): Promise<string> => {
		if (disposed) return "not served: the shell is closing";
		let served: ServedSessions;
		try {
			served = await serveSessionsLocally(
				action,
				deps.env ?? process.env,
				workspaceRoot,
			);
		} catch (error) {
			return `✕ the session browser did not start: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (disposed) {
			await served.close();
			return "not served: the shell is closing";
		}
		servedSessions.add(served);
		return served.banner.trimEnd();
	};
	const tryWorkspaceAction = async (prompt: string): Promise<string | null> => {
		const action = matchWorkspaceAction(prompt);
		if (!action) return null;
		if (action.kind === "create" || action.kind === "create-and-run") {
			const outputDir = join(workspaceRoot, action.exampleId);
			const emitted = emitFromAtoms({
				intent: action.prompt,
				outputDir,
				params: { name: action.exampleId.replace(/[^a-z0-9-]+/giu, "-") },
			});
			if (emitted.ok) {
				linkGeneratedAppRuntime(outputDir);
				lastProjectDir = outputDir;
				if (action.kind === "create") {
					return formatSessionCreateReply({
						id: emitted.compositionId ?? action.exampleId,
						outputDir,
						files: emitted.files,
						holes: emitted.holes,
					});
				}
			} else {
				const copied = materializeExample({
					exampleId: action.exampleId,
					outputDir,
					appName: action.exampleId,
					intent: action.prompt,
				});
				linkGeneratedAppRuntime(copied.outputDir);
				lastProjectDir = copied.outputDir;
				if (action.kind === "create") {
					return formatSessionCreateReply({
						id: copied.templateId,
						outputDir: copied.outputDir,
						files: copied.files,
						holes: [],
					});
				}
			}
		}
		const projectDir = resolveRunnableProject(workspaceRoot, lastProjectDir);
		if (projectDir === undefined) {
			return 'No Bindle to run. Say "create a hello world app" first.';
		}
		const result = await runHoboCodeCli(
			["dev", "--cwd", projectDir, "--port", "0", "--debug-port", "0"],
			{ ...cliDeps, json: false },
		);
		if (!result.ok) {
			return formatHoboCodeResult(result, {
				json: false,
				dense: deps.dense === true,
			});
		}
		const deployment =
			result.data && isJsonObject(result.data)
				? // SAFETY: parsed or fixture value is the named domain type after this assertion.
					(
						result.data as {
							readonly deployment?: {
								readonly appUrl?: string;
								readonly debugUrl?: string;
								readonly controlsUrl?: string;
								readonly reportUrl?: string;
								readonly namedUrl?: string;
								readonly stationId?: string;
								readonly environment?: string;
							};
						}
					).deployment
				: undefined;
		if (
			!deployment?.appUrl ||
			!deployment.debugUrl ||
			!deployment.controlsUrl ||
			!deployment.reportUrl
		) {
			return formatHoboCodeResult(result, {
				json: false,
				dense: deps.dense === true,
			});
		}
		return formatLiveEndpoints({
			appUrl: deployment.appUrl,
			debugUrl: deployment.debugUrl,
			controlsUrl: deployment.controlsUrl,
			reportUrl: deployment.reportUrl,
			...(deployment.namedUrl !== undefined
				? { namedUrl: deployment.namedUrl }
				: undefined),
			...(deployment.stationId !== undefined
				? { stationId: deployment.stationId }
				: undefined),
			...(deployment.environment !== undefined
				? { environment: deployment.environment }
				: undefined),
			emphasis: action.kind === "debug" ? "debug" : "run",
		});
	};
	return {
		...engineExtras,
		async runVerb(argv) {
			if (argv[0] === "hobo" && argv[1] !== "dev") {
				return runHoboCommand(argv.slice(1), deps);
			}
			const codeArgv = argv[0] === "hobo" ? argv.slice(1) : argv;
			let authorization: Promise<void> | undefined;
			let settle = (): void => {};
			try {
				const result = await runHoboCodeCli([...codeArgv], {
					...cliDeps,
					json: false,
					signals: {
						hold: () => {
							if (authorization === undefined) {
								authorization = new Promise<void>((resolve) => {
									settle = resolve;
								});
								authorizing.add(authorization);
							}
							holdForVerb();
						},
						get first() {
							return signals.first;
						},
					},
				});
				const text = formatHoboCodeResult(result, {
					json: false,
					dense: deps.dense === true,
				});
				const forward = handedForward(result);
				if (forward !== undefined) {
					// Handed over once the shell has begun to close, or after a
					// signal it quits on: nothing will stop a forward now, so none
					// is started, and the authorization goes.
					if (disposed || signals.first !== undefined) {
						await forward.closeAuthorization?.(SHELL_QUIT);
						return `${text}\nnot forwarded: the shell is closing; the Station authorization is closed`;
					}
					const running = startShellForward(
						forward,
						deps.env ?? process.env,
						closingReason,
						notice,
						() => forwards.delete(running),
					);
					forwards.add(running);
					return `${text}\n${forwardBanner(forward).trimEnd()}`;
				}
				const local = servedAction(result);
				if (local !== undefined) return `${text}\n${await serveLocally(local)}`;
				await executeResidentTerminalAction(result, deps.env ?? process.env);
				return text;
			} finally {
				if (authorization !== undefined) {
					authorizing.delete(authorization);
					settle();
					// A verb that held the signals only once the shell had begun
					// to close lets them go itself, its authorization closed.
					if (disposed && authorizing.size === 0 && forwards.size === 0)
						releaseSignals();
				}
			}
		},
		dispose: async () => {
			disposed = true;
			// A verb still opening its authorization finishes first: the shell
			// is closing, so it closes what it opened rather than forward it.
			// Every cleanup runs even when one fails (a forward whose
			// authorization would not close must not orphan served/dev
			// sessions or keep the held signals); the first failure is
			// rethrown once everything else is done.
			const settled = await Promise.allSettled([
				...authorizing,
				...[...forwards].map((forward) => forward.stop()),
				...[...servedSessions].map((served) => served.close()),
				...[...devSessions].map((session) => session.close()),
			]);
			servedSessions.clear();
			devSessions.clear();
			if (authorizing.size === 0) releaseSignals();
			const failed = settled.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failed !== undefined) throw failed.reason;
		},
		exitSignal: () => endedBy,
		onNotice(listener) {
			noticeListeners.add(listener);
			return () => {
				noticeListeners.delete(listener);
			};
		},
		// The terminal's hangup is taken as SIGHUP is (see whileHeld above).
		hangUp: () => {
			if (authorizing.size > 0 || forwards.size > 0) endedBy ??= "SIGHUP";
		},
		tryWorkspaceAction,
		async sendToAgent(agent, text) {
			const { IN_SESSION_MUX, sendToInSessionPane } = await import(
				"./in-session-panes.js"
			);
			const { sessionTarget, tmuxRunner } = await import("./mux.js");
			const runner = tmuxRunner();
			const listed = await runner.run([
				"list-windows",
				"-t",
				sessionTarget(IN_SESSION_MUX),
				"-F",
				"#{window_name}\t#{pane_id}",
			]);
			const line = listed.stdout
				.split("\n")
				.find((row) => row.startsWith(`${agent}\t`));
			const target =
				line?.split("\t")[1]?.trim() || `${sessionTarget(IN_SESSION_MUX)}${agent}`;
			await sendToInSessionPane(runner, target, text);
			return `sent to ${agent} in this session — stay here, Tab to panes to watch it work`;
		},
		async complete(prompt) {
			const handled = await tryWorkspaceAction(prompt);
			if (handled !== null) return handled;
			const result = await runHoboCodeCli([prompt], {
				...deps,
				json: false,
			});
			const task = dispatchedTask(result);
			if (result.ok && task?.taskId) {
				return [
					`Recorded compute task ${task.taskId} (status: ${task.status ?? "unknown"}).`,
					"No completion engine is wired yet, so nothing acted on your prompt —",
					// SAFETY: parsed or fixture value is the named domain type after this assertion.
					"it is stored as a dispatch task for a worker to pick up (/about).",
					...(task.handbackPath ? [`Handback: ${task.handbackPath}`] : []),
					oneShotHint(prompt),
				].join("\n");
			}
			if (result.ok) {
				// Non-dispatch success (e.g. a verb-shaped prompt routed elsewhere).
				return formatHoboCodeResult(result, {
					json: false,
					dense: deps.dense === true,
				});
			}
			const remediation = result.remediation ?? [];
			return [
				`${result.code}: ${task?.error ?? "dispatch failed"}`,
				formatHoboCodeResult(result, {
					json: false,
					dense: deps.dense === true,
				}).trimEnd(),
				...(remediation.length > 0
					? ["Try:", ...remediation.map((r) => `  ${r}`)]
					: []),
			].join("\n");
		},
	};
}
