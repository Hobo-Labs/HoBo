import { existsSync, mkdirSync } from "node:fs";
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
	type RunnerLabelsBody,
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
import { defaultInstallationToken } from "./ci-machine-connect.js";

export type CiRunnersDeps = Readonly<{
	openGithub?: (
		context: CiCommandContext,
		repository: string,
	) => Promise<RunnerAdoptionGithub | undefined>;
	openRegistry?: (context: CiCommandContext) => Promise<OpenedMachineRegistry>;
	fetch?: typeof fetch;
	githubApiBase?: string;
}>;

const ACTIONS = ["list", "adopt", "release"] as const;
type RunnersAction = (typeof ACTIONS)[number];

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

const HELP = [
	"hobo ci runners list [--repo owner/name] [--json]",
	"hobo ci runners adopt <runner-id> [--repo owner/name] [--sharing only_me|only-me|anyone] [--account <id>] [--json]",
	"hobo ci runners release <runner-id> [--repo owner/name] [--account <id>] [--json]",
].join("\n");

function isAction(word: string | undefined): word is RunnersAction {
	return ACTIONS.some((action) => action === word);
}

function normalizeSharing(
	word: string | undefined,
): MachineSharing | undefined {
	if (word === undefined) return undefined;
	const normalized = word === "only-me" ? "only_me" : word;
	return MACHINE_SHARING.find((sharing) => sharing === normalized);
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

function createGithubAppAdoptionClient(
	token: string,
	apiBase: string,
	fetchImpl: typeof fetch,
): RunnerAdoptionGithub {
	const base = apiBase.replace(/\/+$/u, "");
	return {
		request(
			method: "GET" | "POST" | "DELETE",
			path: string,
			body: RunnerLabelsBody | undefined,
		): Promise<Response> {
			const headers = {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"user-agent": "hobo-cli",
				"x-github-api-version": "2022-11-28",
				...(body === undefined
					? undefined
					: { "content-type": "application/json" }),
			};
			return fetchImpl(`${base}${path}`, {
				method,
				headers,
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			});
		},
	};
}

async function defaultOpenGithub(
	context: CiCommandContext,
	repository: string,
	apiBase: string,
	fetchImpl: typeof fetch,
): Promise<RunnerAdoptionGithub | undefined> {
	const token = await defaultInstallationToken(repository, context.credentials);
	if (!token) return undefined;
	return createGithubAppAdoptionClient(token, apiBase, fetchImpl);
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
	const apiBase = deps.githubApiBase ?? DEFAULT_GITHUB_API_BASE;
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

			const expectedPositionals = action === "list" ? 1 : 2;
			if (parsed.positionals.length > expectedPositionals) {
				return usage(
					`Unexpected extra argument "${parsed.positionals[expectedPositionals] ?? ""}".`,
				);
			}

			const explicitRepo = parsed.values.repo;
			if (
				explicitRepo !== undefined &&
				!REPOSITORY_PATTERN.test(explicitRepo)
			) {
				return usage(`Invalid --repo "${explicitRepo}". Expected owner/name.`);
			}

			const repository =
				explicitRepo ?? (await context.localRepository(undefined)).repository;
			if (!repository) {
				return usage("Pass --repo owner/name or run inside a GitHub checkout.");
			}

			const github = deps.openGithub
				? await deps.openGithub(context, repository)
				: await defaultOpenGithub(
						context,
						repository,
						apiBase,
						deps.fetch ?? context.fetch,
					);
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
				if (!rawId || !POSITIVE_INTEGER_PATTERN.test(rawId)) {
					return usage(`Pass a positive numeric runner id to ${action}.`);
				}
				const runnerId = Number.parseInt(rawId, 10);
				if (!Number.isSafeInteger(runnerId) || runnerId <= 0) {
					return usage(`Pass a positive numeric runner id to ${action}.`);
				}

				if (action === "adopt") {
					const sharingValue = parsed.values.sharing;
					const normalizedSharing = normalizeSharing(sharingValue);
					if (sharingValue !== undefined && normalizedSharing === undefined) {
						return usage(
							`--sharing must be one of: ${MACHINE_SHARING.join(", ")}.`,
						);
					}
					const adopter = await runnerAdopter(github, repository);
					const adopted = await adoptRunner(github, {
						repository,
						runnerId,
						accountId,
						adopter,
						sharing: normalizedSharing,
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
				const shouldOpenRegistry =
					deps.openRegistry !== undefined ||
					existsSync(localMachineRegistryPath(context.env));
				if (shouldOpenRegistry) {
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
