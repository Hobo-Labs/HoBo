/**
 * `hobo ci machine connect`: make this computer a machine HoBo CI routes jobs
 * to (ADR-0183), from an installed CLI with no checkout.
 *
 *     hobo ci machine connect --repo <owner/name> [--repo …] [--name <name>]
 *         [--concurrency <n>] [--share only-me|anyone] [--host] [--image <ref>]
 *         [--events] [--account <id>]
 *
 * The owner signs in with GitHub's CLI (`gh auth token`) or a token in
 * GH_TOKEN or GITHUB_TOKEN; the token is used for GitHub's REST API only and
 * never reaches a job. The machine keeps its id and key under HOBO_HOME
 * (`ci/machine/`), advertises itself every 30 seconds in the local node's
 * machine registry, reads the named repositories' queues for its own label,
 * and runs each job on a one-job runner in a fresh container (`--host`: on
 * this machine, and the advert says so). `p` on a terminal pauses and
 * resumes. Ctrl-C drains: running jobs finish and the machine goes offline;
 * a second Ctrl-C stops them as well. `--events` prints each event as one
 * JSON object per line. Public repositories and fork pull requests never
 * run here.
 *
 * Every other `hobo ci machine` word goes to `ci-machine.ts`.
 */
import { mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
	MACHINE_SHARING,
	type MachineRegistry,
	type MachineSharing,
} from "@hobo/ci";
import { SqliteMachineRegistry } from "@hobo/ci/runner-order/machine-registry-sqlite";
import { createCliDockerDriver } from "@hobo/ci-gh-actions";
import {
	containerExecutor,
	createMachineWorker,
	DEFAULT_MACHINE_IMAGE,
	githubOwner,
	githubQueueJobSource,
	hostExecutor,
	nodeHostProcess as hostProcess,
	type JobExecutor,
	loadMachine,
	type MachineGithub,
	type MachineSession,
	type MachineWorkerEvent,
	machinePlatform,
	machineRunsOnLabel,
	machineWorkerEventJson,
	pinnedRunnerProgram,
	registryAdvertSink,
	runMachineSession,
	userGithub,
} from "@hobo/ci-gh-actions/machine-worker";
import type { CommandResult } from "@hobo/cli";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import {
	CI_MACHINE_COMMAND,
	LOCAL_MACHINE_ACCOUNT,
	localMachineRegistryPath,
	type OpenedMachineRegistry,
} from "./ci-machine.js";
import { type CiRunExec, runCiProcess } from "./ci-runs.js";
import { defaultHoboHome } from "./hobo-home.js";

const HELP = [
	"hobo ci machine connect --repo <owner/name> [--repo …]",
	"    Run jobs routed to this machine until Ctrl-C (drain; twice: stop running jobs).",
	"    --name <name>            What people see (default: this computer's name).",
	"    --concurrency <n>        Jobs at once, 1 to 32 (default 1).",
	"    --share only-me|anyone   Who may route jobs here (default only-me).",
	"    --host                   Run jobs on this machine instead of a fresh container.",
	"    --image <ref>            The job container's image.",
	"    --events                 Print each event as one JSON object per line.",
	"    --account <id>           The account (or HOBO_CI_ACCOUNT_ID; default local).",
	"    Press p to pause or resume. Sign in with gh auth login, or set GH_TOKEN.",
].join("\n");

const MAX_CONCURRENCY = 32;

/** What the executor is built from. */
export type MachineExecutorChoice = Readonly<{
	host: boolean;
	image: string;
	arch: "x64" | "arm64";
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	/** Where the host executor keeps the pinned runner archive. */
	cacheDir: string;
}>;

/** What the command reaches outside itself; each has a real default. */
export type CiMachineConnectDeps = Readonly<{
	/** The owner's GitHub token: GH_TOKEN, GITHUB_TOKEN, else `gh auth token`. */
	githubToken?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
	/** GitHub's REST API with the token. */
	github?: (token: string, fetcher: typeof fetch) => MachineGithub;
	openRegistry?: (context: CiCommandContext) => Promise<OpenedMachineRegistry>;
	executor?: (choice: MachineExecutorChoice) => JobExecutor;
	platform?: Readonly<{ platform: string; arch: string }>;
	hostname?: () => string;
	/** Wires Ctrl-C and the terminal's `p` to the session; returns the undo. */
	controls?: (session: MachineSession) => () => void;
	/** Prints one `--events` line. */
	writeLine?: (line: string) => void;
	tickEveryMs?: number;
	wait?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Every other `hobo ci machine` word. */
	machine?: CiCommand;
}>;

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CI_MACHINE_USAGE",
		message: `${message}\n${HELP}`,
	};
}

/**
 * GH_TOKEN, GITHUB_TOKEN, else what `gh auth token` prints. `gh` runs in the
 * system's temporary directory, which always exists: on a clean machine
 * HOBO_HOME does not yet, and a missing working directory fails the call.
 */
export async function defaultGithubToken(
	env: NodeJS.ProcessEnv,
	exec: CiRunExec = runCiProcess,
): Promise<string | undefined> {
	const named = env.GH_TOKEN || env.GITHUB_TOKEN;
	if (named) return named;
	try {
		const { stdout } = await exec("gh", ["auth", "token"], {
			cwd: tmpdir(),
			timeout: 15_000,
			maxBuffer: 64 * 1024,
			env,
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

function defaultExecutor(choice: MachineExecutorChoice): JobExecutor {
	if (choice.host)
		return hostExecutor({
			program: pinnedRunnerProgram({
				fetch: choice.fetch,
				cacheDir: choice.cacheDir,
				arch: choice.arch,
				process: hostProcess,
				env: choice.env,
			}),
			process: hostProcess,
			env: choice.env,
		});
	return containerExecutor({
		docker: createCliDockerDriver({ env: choice.env }),
		image: choice.image,
		arch: choice.arch,
		env: choice.env,
	});
}

/** Ctrl-C stops (twice: hands off); `p` on a terminal pauses and resumes. */
function processControls(session: MachineSession): () => void {
	const interrupt = () => session.stop();
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	const input = process.stdin;
	const keyed = input.isTTY === true;
	const key = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		if (text === "\u0003") session.stop();
		else if (text.toLowerCase() === "p") void session.togglePause();
	};
	if (keyed) {
		input.setRawMode(true);
		input.resume();
		input.on("data", key);
	}
	return () => {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		if (keyed) {
			input.off("data", key);
			input.setRawMode(false);
			input.pause();
		}
	};
}

function eventLine(event: MachineWorkerEvent): string | undefined {
	return "detail" in event ? event.detail : undefined;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function sharingOf(word: string | undefined): MachineSharing | undefined {
	const sharing = (word ?? "only_me").replace("-", "_");
	return MACHINE_SHARING.find((known) => known === sharing);
}

function parseConnectArgs(args: readonly string[]) {
	try {
		const { values, positionals } = parseArgs({
			args: [...args],
			allowPositionals: true,
			strict: true,
			options: {
				repo: { type: "string", multiple: true },
				name: { type: "string" },
				concurrency: { type: "string" },
				share: { type: "string" },
				host: { type: "boolean" },
				image: { type: "string" },
				events: { type: "boolean" },
				account: { type: "string" },
				// The CLI's global --json, which renders the final result as data;
				// accepted here as in ci-machine.ts. --events is the event stream.
				json: { type: "boolean" },
			},
		});
		if (positionals.length > 0)
			return usage("hobo ci machine connect takes no positional arguments.");
		const repositories = values.repo ?? [];
		if (repositories.length === 0)
			return usage(
				"Name the repositories whose jobs this machine takes with --repo <owner/name>.",
			);
		const bad = repositories.find((repo) => !REPOSITORY.test(repo));
		if (bad !== undefined) return usage(`${bad} is not owner/name.`);
		const concurrency = Number(values.concurrency ?? "1");
		if (
			!Number.isInteger(concurrency) ||
			concurrency < 1 ||
			concurrency > MAX_CONCURRENCY
		)
			return usage(
				`--concurrency is a whole number from 1 to ${MAX_CONCURRENCY}.`,
			);
		const sharing = sharingOf(values.share);
		if (sharing === undefined) return usage("--share is only-me or anyone.");
		return {
			repositories: [...new Set(repositories)],
			name: values.name,
			concurrency,
			sharing,
			host: values.host === true,
			image: values.image ?? DEFAULT_MACHINE_IMAGE,
			events: values.events === true,
			account: values.account,
		};
	} catch (error) {
		return usage(error instanceof Error ? error.message : "Invalid arguments.");
	}
}

/** The local node's registry, the one `hobo ci machine status` reads. */
async function openLocal(
	context: CiCommandContext,
): Promise<OpenedMachineRegistry> {
	const path = localMachineRegistryPath(context.env);
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	const registry: MachineRegistry = new SqliteMachineRegistry(db);
	return { registry, where: path, close: () => db.close() };
}

async function connect(
	context: CiCommandContext,
	deps: CiMachineConnectDeps,
): Promise<CommandResult> {
	const parsed = parseConnectArgs(context.args);
	if (!("repositories" in parsed)) return parsed;
	const where = deps.platform ?? {
		platform: process.platform,
		arch: process.arch,
	};
	const platform = machinePlatform(where.platform, where.arch);
	if (!platform.supported)
		return {
			ok: false,
			status: "unsupported",
			code: "HOBO_CI_MACHINE_UNSUPPORTED",
			message: platform.reason,
			remediation: ["Connect a Linux machine (x64 or arm64)."],
		};
	const token = await (deps.githubToken ?? defaultGithubToken)(context.env);
	const github = token
		? (
				deps.github ??
				((value, fetcher) => userGithub({ fetch: fetcher, token: value }))
			)(token, context.fetch)
		: undefined;
	const owner = github ? await githubOwner(github) : undefined;
	if (!github || !owner)
		return {
			ok: false,
			status: "unauthenticated",
			code: "HOBO_CI_MACHINE_SIGN_IN",
			message: token
				? "GitHub did not accept the token this machine was given."
				: "Sign in to GitHub before connecting this machine.",
			remediation: [
				"Run gh auth login, or set GH_TOKEN to a token that can manage the named repositories' self-hosted runners.",
			],
		};
	const home = join(defaultHoboHome(context.env), "ci", "machine");
	const machine = await loadMachine(home, {
		name: parsed.name,
		defaultName: (deps.hostname ?? hostname)(),
	});
	const accountId =
		parsed.account ?? context.env.HOBO_CI_ACCOUNT_ID ?? LOCAL_MACHINE_ACCOUNT;
	const opened = await (deps.openRegistry ?? openLocal)(context);
	const writeLine =
		deps.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
	const isolation = parsed.host ? "host" : "container";
	const label = machineRunsOnLabel(machine.id);
	const worker = createMachineWorker({
		profile: {
			id: machine.id,
			name: machine.name,
			os: platform.os,
			arch: platform.arch,
			accountId,
			ownerId: owner.ownerId,
			ownerLogin: owner.ownerLogin,
			isolation,
		},
		identity: machine.identity,
		sink: registryAdvertSink(opened.registry, { accountId, ...owner }),
		jobs: githubQueueJobSource({
			github,
			repositories: parsed.repositories,
			label,
		}),
		github,
		executor: (deps.executor ?? defaultExecutor)({
			host: parsed.host,
			image: parsed.image,
			arch: platform.arch,
			env: context.env,
			fetch: context.fetch,
			cacheDir: join(home, "runner"),
		}),
		concurrency: parsed.concurrency,
		sharing: parsed.sharing,
		now: context.now,
		emit: (event) => {
			if (parsed.events) writeLine(machineWorkerEventJson(event));
			else {
				const line = eventLine(event);
				if (line !== undefined) context.emitProgress(line);
			}
		},
	});
	context.emitProgress(
		[
			`Machine ${machine.name} (${machine.id}) connected as ${owner.ownerLogin} for account ${accountId}.`,
			`Jobs with runs-on ${label} in ${parsed.repositories.join(", ")} run ${isolation === "host" ? "ON THIS MACHINE as you, not in a container" : "in a fresh container each"}, ${parsed.concurrency} at a time.`,
			"Press p to pause or resume, Ctrl-C to drain and go offline (twice: stop running jobs).",
		].join("\n"),
	);
	const session = runMachineSession({
		worker,
		...(deps.tickEveryMs === undefined
			? undefined
			: { tickEveryMs: deps.tickEveryMs }),
		...(deps.wait === undefined ? undefined : { wait: deps.wait }),
		onError: (error) =>
			context.emitProgress(`This tick failed and is retried: ${error.message}`),
	});
	const undo = (deps.controls ?? processControls)(session);
	try {
		const status = await session.done;
		const data = {
			machine: machine.id,
			name: machine.name,
			account: accountId,
			runsOn: label,
			isolation,
			registry: opened.where,
			finished: status.finished,
			failed: status.failed,
			refused: status.refused ?? null,
		};
		if (status.refused !== undefined)
			return {
				ok: false,
				status: "refused",
				code: "HOBO_CI_MACHINE_REFUSED",
				message: status.refused,
				remediation: [
					`Run hobo ci machine remove ${machine.id} as its owner, then connect again.`,
				],
				data,
			};
		return {
			message: `Machine ${machine.name} is offline; its jobs ran ${isolation === "host" ? "on this machine's host" : "in fresh containers"}: ${status.finished} finished, ${status.failed} failed or stopped.`,
			data,
		};
	} finally {
		undo();
		opened.close();
	}
}

/**
 * `hobo ci machine`: `connect` runs here; every other word goes to the
 * machine command of `ci-machine.ts`.
 */
export function createCiMachineConnectCommand(
	deps: CiMachineConnectDeps = {},
): CiCommand {
	const machine = deps.machine ?? CI_MACHINE_COMMAND;
	return {
		name: machine.name,
		summary: `Connect this computer (connect), or ${machine.summary.charAt(0).toLowerCase()}${machine.summary.slice(1)}`,
		async run(context) {
			if (context.args[0] !== "connect") {
				const result = await machine.run(context);
				return context.args.length === 0 && result.ok !== false
					? { ...result, message: `${HELP}\n${result.message}` }
					: result;
			}
			return connect({ ...context, args: context.args.slice(1) }, deps);
		},
	};
}

export const CI_MACHINE_CONNECT_COMMAND = createCiMachineConnectCommand();
