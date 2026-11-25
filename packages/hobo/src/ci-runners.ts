import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { toJson } from "@bufbuild/protobuf";
import {
	MACHINE_SHARING,
	MachineAdvertSchema,
	type MachineRegistry,
	type MachineSharing,
	removeMachine,
} from "@hobo/ci";
import { SqliteMachineRegistry } from "@hobo/ci/runner-order/machine-registry-sqlite";
import {
	type AdoptableRunner,
	adoptRunner,
	listAdoptableRunners,
	RunnerAdoptionError,
	type RunnerAdoptionGithub,
	releaseRunner,
	runnerAdopter,
} from "@hobo/ci-gh-actions/cli-serve";
import type { CommandResult } from "@hobo/cli";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import {
	LOCAL_MACHINE_ACCOUNT,
	localMachineRegistryPath,
	type OpenedMachineRegistry,
} from "./ci-machine.js";

export type CiRunnersDeps = Readonly<{
	openGithub?: (
		context: CiCommandContext,
		repository: string,
	) => Promise<RunnerAdoptionGithub | undefined>;
	openRegistry?: (context: CiCommandContext) => Promise<OpenedMachineRegistry>;
}>;

const ACTIONS = ["list", "adopt", "release"] as const;
type RunnersAction = (typeof ACTIONS)[number];

const HELP = [
	"hobo ci runners list [--repo owner/name] [--json]",
	"hobo ci runners adopt <runner-id> [--repo owner/name] [--sharing only_me|anyone] [--account <id>] [--json]",
	"hobo ci runners release <runner-id> [--repo owner/name] [--account <id>] [--json]",
].join("\n");

function isAction(word: string | undefined): word is RunnersAction {
	return ACTIONS.some((action) => action === word);
}

function isSharing(word: string | undefined): word is MachineSharing {
	return MACHINE_SHARING.some((sharing) => sharing === word);
}

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CLI_USAGE",
		message: `${message}\n${HELP}`,
	};
}

function formatRunner(runner: AdoptableRunner): string {
	const adopted = runner.adoptedLabel
		? `adopted (${runner.adoptedLabel})`
		: "not adopted";
	return `${runner.id}  ${runner.name}  ${runner.scope}:${runner.registeredOn}  ${runner.os}  ${runner.status}${runner.busy ? "/busy" : ""}  ${adopted}`;
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

async function recordAdoptedAdvert(
	registry: MachineRegistry,
	accountId: string,
	advert: Parameters<MachineRegistry["put"]>[0],
): Promise<void> {
	await registry.put({ ...advert, accountId });
}

function parseRunnersArgs(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			repo: { type: "string" },
			sharing: { type: "string" },
			account: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

export function createCiRunnersCommand(deps: CiRunnersDeps = {}): CiCommand {
	const openRegistry = deps.openRegistry ?? openLocalRegistry;
	return {
		name: "runners",
		summary:
			"List, adopt, or release existing GitHub self-hosted runners without modifying the machine.",
		run: async (context) => {
			let parsed: ReturnType<typeof parseRunnersArgs>;
			try {
				parsed = parseRunnersArgs(context.args);
			} catch (error) {
				return usage(error instanceof Error ? error.message : String(error));
			}

			if (parsed.values.help) {
				return { message: HELP, data: { help: HELP } };
			}

			const action = parsed.positionals[0];
			if (!isAction(action)) {
				return usage(
					action
						? `Unknown runners subcommand "${action}".`
						: "Choose list, adopt, or release.",
				);
			}

			const local = await context.localRepository(parsed.values.repo);
			const repository = local.repository;
			if (!repository) {
				return usage("Pass --repo owner/name or run inside a GitHub checkout.");
			}

			const github = deps.openGithub
				? await deps.openGithub(context, repository)
				: undefined;
			if (!github) {
				return {
					ok: false,
					status: "auth",
					code: "HOBO_CI_AUTH_REQUIRED",
					message:
						"Connect HoBo's GitHub App (`hobo ci connect`) before listing or adopting self-hosted runners.",
				};
			}

			const accountId =
				parsed.values.account ??
				context.env.HOBO_CI_ACCOUNT_ID ??
				LOCAL_MACHINE_ACCOUNT;

			try {
				if (action === "list") {
					const listing = await listAdoptableRunners(github, repository);
					const lines =
						listing.runners.length === 0
							? [`No adoptable self-hosted runners for ${listing.repository}.`]
							: listing.runners.map(formatRunner);
					return {
						message: [...lines, ...listing.warnings].join("\n"),
						data: listing,
					};
				}

				const rawId = parsed.positionals[1];
				const runnerId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
				if (!Number.isInteger(runnerId) || runnerId <= 0) {
					return usage(`Pass a positive numeric runner id to ${action}.`);
				}

				if (action === "adopt") {
					const sharingValue = parsed.values.sharing;
					if (sharingValue !== undefined && !isSharing(sharingValue)) {
						return usage(
							`--sharing must be one of: ${MACHINE_SHARING.join(", ")}.`,
						);
					}
					const adopter = await runnerAdopter(github);
					const adopted = await adoptRunner(github, {
						repository,
						runnerId,
						accountId,
						adopter,
						sharing: sharingValue,
						nowMs: context.now(),
					});
					const opened = await openRegistry(context);
					try {
						await recordAdoptedAdvert(
							opened.registry,
							accountId,
							adopted.advert,
						);
					} finally {
						opened.close();
					}
					return {
						message: adopted.changed
							? `Adopted runner ${adopted.runner.name} (${adopted.runner.id}) with label ${adopted.label}.`
							: `Runner ${adopted.runner.name} (${adopted.runner.id}) is already adopted with label ${adopted.label}.`,
						data: {
							runner: adopted.runner,
							label: adopted.label,
							changed: adopted.changed,
							advert: toJson(MachineAdvertSchema, adopted.advert),
						},
					};
				}

				const released = await releaseRunner(github, {
					repository,
					runnerId,
				});
				const opened = await openRegistry(context);
				try {
					await removeMachine(opened.registry, {
						accountId,
						id: `github-runner-${runnerId}`,
						by: "cli",
						nowMs: context.now(),
					});
				} finally {
					opened.close();
				}
				return {
					message:
						released.removed.length > 0
							? `Released runner ${released.runner.name} (${released.runner.id}); removed ${released.removed.join(", ")}.`
							: `Runner ${released.runner.name} (${released.runner.id}) had no HoBo adoption label.`,
					data: released,
				};
			} catch (error) {
				if (error instanceof RunnerAdoptionError) {
					return {
						ok: false,
						status: error.problem === "forbidden" ? "auth" : "error",
						code:
							error.problem === "forbidden"
								? "HOBO_CI_AUTH_REQUIRED"
								: "HOBO_CI_RELAY_ERROR",
						message: error.message,
					};
				}
				throw error;
			}
		},
	};
}

export const CI_RUNNERS_COMMAND = createCiRunnersCommand();
