/**
 * `hobo ci machine`: see and steer the machines connected to a HoBo node.
 *
 *     hobo ci machine status [<id>]
 *     hobo ci machine pause <id>
 *     hobo ci machine resume <id>
 *     hobo ci machine share <id> only_me|anyone
 *     hobo ci machine remove <id>
 *
 * Each acts on one account's machines in a machine registry (ADR-0183). By
 * default that is the SQLite registry a local node keeps under HOBO_HOME
 * (`HOBO_CI_MACHINE_REGISTRY` names another file), for account `local`
 * unless `--account` or `HOBO_CI_ACCOUNT_ID` names one. A pause lets running
 * jobs finish; a removal takes effect at the next decision and forgets the
 * machine's key. Every change is safe to repeat: asking for what is already
 * true changes nothing and says so. `--json` gives the same result as data.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { toJson } from "@bufbuild/protobuf";
import {
	MACHINE_SHARING,
	type MachineAdvert,
	MachineAdvertSchema,
	type MachineChange,
	type MachineRegistry,
	type MachineSharing,
	machineOnline,
	removeMachine,
	setMachinePaused,
	setMachineSharing,
} from "@hobo/ci";
import { SqliteMachineRegistry } from "@hobo/ci/runner-order/machine-registry-sqlite";
import type { CommandResult } from "@hobo/cli";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import { defaultHoboHome } from "./hobo-home.js";

/** A registry the command acts on, and how to let it go. */
export type OpenedMachineRegistry = Readonly<{
	registry: MachineRegistry;
	/** Where it is, for people: a file path or a relay origin. */
	where: string;
	close: () => void;
}>;

export type CiMachineDeps = Readonly<{
	/** Opens the registry; the local SQLite file when absent. */
	openRegistry?: (context: CiCommandContext) => Promise<OpenedMachineRegistry>;
}>;

// public-contract: the account a local node's registry uses when none is named.
export const LOCAL_MACHINE_ACCOUNT = "local";

const ACTIONS = ["status", "pause", "resume", "share", "remove"] as const;
type MachineAction = (typeof ACTIONS)[number];

const HELP = [
	"hobo ci machine status [<id>]           List machines: online, paused, busy slots, sharing.",
	"hobo ci machine pause <id>              Take no new jobs; running jobs finish.",
	"hobo ci machine resume <id>             Take jobs again.",
	"hobo ci machine share <id> only_me|anyone",
	"                                        only_me: runs started by you; anyone: anyone, if you can read the repository.",
	"hobo ci machine remove <id>             Forget the machine and its key at once.",
	"Options: --account <id> (or HOBO_CI_ACCOUNT_ID), --json.",
].join("\n");

/** The registry file a local node keeps. */
export function localMachineRegistryPath(env: NodeJS.ProcessEnv): string {
	return (
		env.HOBO_CI_MACHINE_REGISTRY ??
		join(defaultHoboHome(env), "ci", "machines.sqlite")
	);
}

async function openLocalRegistry(
	context: CiCommandContext,
): Promise<OpenedMachineRegistry> {
	const path = localMachineRegistryPath(context.env);
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	return {
		registry: new SqliteMachineRegistry(db),
		where: path,
		close: () => db.close(),
	};
}

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CI_MACHINE_USAGE",
		message: `${message}\n${HELP}`,
	};
}

function isAction(word: string | undefined): word is MachineAction {
	return ACTIONS.some((action) => action === word);
}

function isSharing(word: string | undefined): word is MachineSharing {
	return MACHINE_SHARING.some((sharing) => sharing === word);
}

function ago(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 120) return `${seconds} s ago`;
	const minutes = Math.round(seconds / 60);
	return minutes < 120
		? `${minutes} min ago`
		: `${Math.round(minutes / 60)} h ago`;
}

function line(machine: MachineAdvert, nowMs: number): string {
	const state = machineOnline(machine, nowMs)
		? machine.paused
			? "paused"
			: "online"
		: "offline";
	return [
		`${machine.name} (${machine.id})`,
		state,
		`${machine.busy}/${machine.slots} busy`,
		`shared with ${machine.sharing === "anyone" ? "anyone" : "only its owner"}`,
		`${machine.isolation === "container" ? "a fresh container per job" : "jobs on the host"}`,
		`runs-on ${machine.runsOn}`,
		`seen ${ago(nowMs - machine.lastSeenMs)}`,
	].join(" · ");
}

function machineData(machine: MachineAdvert, nowMs: number) {
	return {
		advert: toJson(MachineAdvertSchema, machine),
		online: machineOnline(machine, nowMs),
	};
}

function missing(id: string, account: string): CommandResult {
	return {
		ok: false,
		status: "not-found",
		code: "HOBO_CI_MACHINE_NOT_FOUND",
		message: `No machine ${id} is connected for account ${account}.`,
		remediation: ["Run hobo ci machine status to list the machines."],
	};
}

function changed(
	change: MachineChange,
	id: string,
	account: string,
	done: string,
	already: string,
): CommandResult {
	const machine = change.machine;
	if (!machine) return missing(id, account);
	return {
		message: change.event
			? change.event.detail
			: `Machine ${machine.name} ${already}; nothing changed.`,
		data: {
			account,
			machine: machine.id,
			changed: change.event !== undefined,
			event: change.event ?? null,
			action: done,
		},
	};
}

async function act(
	action: MachineAction,
	positionals: readonly string[],
	opened: OpenedMachineRegistry,
	request: Readonly<{ accountId: string; by: string; nowMs: number }>,
): Promise<CommandResult> {
	const { registry } = opened;
	const id = positionals[0];
	if (action === "status") {
		if (positionals.length > 1)
			return usage("hobo ci machine status takes at most one machine id.");
		const machines = (await registry.list(request.accountId)).filter(
			(machine) => id === undefined || machine.id === id,
		);
		if (id !== undefined && machines.length === 0)
			return missing(id, request.accountId);
		return {
			message:
				machines.length === 0
					? `No machine is connected for account ${request.accountId} (${opened.where}).`
					: machines.map((machine) => line(machine, request.nowMs)).join("\n"),
			data: {
				account: request.accountId,
				registry: opened.where,
				machines: machines.map((machine) =>
					machineData(machine, request.nowMs),
				),
			},
		};
	}
	if (id === undefined)
		return usage(`hobo ci machine ${action} needs a machine id.`);
	if (action === "share") {
		const sharing = positionals[1];
		if (positionals.length !== 2 || !isSharing(sharing))
			return usage(
				"hobo ci machine share takes a machine id and only_me or anyone.",
			);
		return changed(
			await setMachineSharing(registry, { ...request, id, sharing }),
			id,
			request.accountId,
			"share",
			`is already shared that way`,
		);
	}
	if (positionals.length !== 1)
		return usage(`hobo ci machine ${action} takes one machine id.`);
	if (action === "remove") {
		const change = await removeMachine(registry, { ...request, id });
		if (!change.machine)
			return {
				message: `No machine ${id} is connected for account ${request.accountId}; nothing to remove.`,
				data: {
					account: request.accountId,
					machine: id,
					changed: false,
					event: null,
					action,
				},
			};
		return changed(
			change,
			id,
			request.accountId,
			action,
			"was already removed",
		);
	}
	const paused = action === "pause";
	return changed(
		await setMachinePaused(registry, { ...request, id, paused }),
		id,
		request.accountId,
		action,
		paused ? "is already paused" : "is not paused",
	);
}

function parseMachineArgs(args: readonly string[]) {
	try {
		const { values, positionals } = parseArgs({
			args: [...args],
			allowPositionals: true,
			strict: true,
			options: {
				account: { type: "string" },
				json: { type: "boolean" },
			},
		});
		return { positionals, account: values.account };
	} catch (error) {
		return usage(error instanceof Error ? error.message : "Invalid arguments.");
	}
}

/** `hobo ci machine`, over the given registry or the local one. */
export function createCiMachineCommand(deps: CiMachineDeps = {}): CiCommand {
	return {
		name: "machine",
		summary: "List connected machines; pause, resume, share or remove one.",
		async run(context) {
			const parsed = parseMachineArgs(context.args);
			if (!("positionals" in parsed)) return parsed;
			const [word, ...positionals] = parsed.positionals;
			if (word === undefined) return { message: HELP };
			if (!isAction(word)) return usage(`Unknown machine command ${word}.`);
			const accountId =
				parsed.account ??
				context.env.HOBO_CI_ACCOUNT_ID ??
				LOCAL_MACHINE_ACCOUNT;
			const opened = await (deps.openRegistry ?? openLocalRegistry)(context);
			try {
				return await act(word, positionals, opened, {
					accountId,
					by: context.env.USER ?? context.env.USERNAME ?? "local",
					nowMs: context.now(),
				});
			} finally {
				opened.close();
			}
		},
	};
}

export const CI_MACHINE_COMMAND = createCiMachineCommand();
