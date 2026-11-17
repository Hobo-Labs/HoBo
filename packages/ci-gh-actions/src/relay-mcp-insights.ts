/**
 * The relay's MCP insight tools (ADR-0183): the runner order, a route
 * explanation, route decisions, machines, signals, job times, run failures
 * and usage, for the authenticated account only.
 *
 * Every tool is read-only and needs only the read scope. `explain_route`
 * walks the committed order for the inputs it is given with the facts true
 * now, through the same `answerRelayJob` both relay modes call, and keeps the
 * journal entries it would write to itself: nothing is recorded. Results are
 * compact JSON; a refusal reads `message (CODE)`.
 *
 * The tools read ports, never a store or GitHub directly. On a host that
 * keeps no journal, machines or run history (the stateless Vercel host) the
 * tool that needs one says so and names the command that reads GitHub
 * instead.
 */
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	ACTIVITY_OUTCOMES,
	ACTIVITY_PAGE_MAX,
	type ActivityCursor,
	activityFeed,
	answerRelayJob,
	type InsightStore,
	journalActivity,
	type MachineAdvert,
	type MachineRegistry,
	type MinutesReader,
	machineOnline,
	RELAY_JOB_INPUTS,
	RELAY_MCP_TOOLS,
	RelayJobMessageSchema,
	type RouteDecisionQuery,
	type RouteFactsSource,
	type RouteJournal,
	RUNNER_STEP_KEYS,
	RunnerOrderSchema,
	type RunnerOrderSource,
	type RunnerRouteEvent,
} from "@hobo/ci";
import {
	ciSignals,
	diagnoseFailure,
	type InsightRun,
	jobTimes,
	runnerKey,
	runnerTimes,
	summarizeDiagnosis,
} from "@hobo/ci/insights";
import { type MinuteRate, usageReport } from "@hobo/ci/insights/usage";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	CallToolResult,
	ServerNotification,
	ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { reportRelayFailure } from "./failure-log.js";

// public-contract: the scope every insight tool needs, and the only one.
export const RELAY_MCP_INSIGHT_SCOPE = "policy:read";
// public-contract: the most days of history an insight tool reads (the journal keeps 90).
export const RELAY_MCP_INSIGHT_MAX_DAYS = 90;
// public-contract: days of history an insight tool reads when the caller names none.
export const RELAY_MCP_INSIGHT_DEFAULT_DAYS = 30;
// public-contract: the most run attempts one insight tool reads.
export const RELAY_MCP_INSIGHT_RUNS = 1_000;
// public-contract: the most failed jobs `get_run_failures` diagnoses in one run.
export const RELAY_MCP_DIAGNOSED_JOBS = 5;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The ids an explanation gives its relay job; nothing outside this file sees them. */
const EXPLAIN_ID = "explain";
const EXPLAIN_NODE = "explain_route";

/** Whether GitHub bills a repository's hosted minutes: private ones only. */
export type RepositoryVisibility = "public" | "private";

/** Reads the end of one job's log; undefined when it cannot be read. */
export interface FailureLogReader {
	logTail(repository: string, jobId: number): Promise<string | undefined>;
}

/** What the insight tools read. A port that is undefined is not kept on this host. */
export type RelayMcpInsightServices = Readonly<{
	order: RunnerOrderSource;
	facts: RouteFactsSource;
	journal: RouteJournal | undefined;
	machines: MachineRegistry | undefined;
	runs: InsightStore | undefined;
	minutes: MinutesReader | undefined;
	failureLogs: FailureLogReader | undefined;
	/**
	 * The repositories connected to an account, by lower-case `owner/name`.
	 * A tool given any other repository refuses it, so one account never
	 * reads another's order, runs or failures.
	 */
	repositories: (
		accountId: string,
	) => Promise<ReadonlyMap<string, RepositoryVisibility>>;
	/** GitHub's per-minute rate, with its page and the day it was read, for `get_usage`. */
	githubRate: MinuteRate;
	now: () => number;
	/**
	 * Take one of the account's places for a call in progress, as the relay's
	 * other tools do; false when it holds all of them. Absent: no limit here.
	 */
	beginCall?: ((accountId: string) => boolean) | undefined;
	endCall?: ((accountId: string) => void) | undefined;
}>;

/** A refusal: the code an agent matches on, the sentence, and what to do. */
type Refusal = Readonly<{ code: string; message: string; remediation: string }>;

class InsightRefusal extends Error {
	override readonly name = "InsightRefusal";
	constructor(readonly refusal: Refusal) {
		super(refusal.message);
	}
}

function refused(
	code: string,
	message: string,
	remediation: string,
): InsightRefusal {
	return new InsightRefusal({ code, message, remediation });
}

function notStored(what: string, instead: string): InsightRefusal {
	return refused(
		"HOBO_CI_MCP_NOT_STORED",
		`This relay keeps no ${what}`,
		`Instead, ${instead}.`,
	);
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Who a call acts as: the account the HTTP layer authenticated, and its scopes. */
type Caller = Readonly<{ accountId: string; scopes: readonly string[] }>;

function callerOf(extra: Extra): Caller {
	const auth = extra.authInfo;
	if (!auth?.clientId)
		throw refused(
			"HOBO_CI_MCP_AUTH_REQUIRED",
			"account authentication required",
			"Send the account's bearer token with the request.",
		);
	return { accountId: auth.clientId, scopes: auth.scopes };
}

const Structured = z.record(z.string(), z.json());

function answer(text: string): CallToolResult {
	return {
		content: [{ type: "text", text }],
		structuredContent: Structured.parse(JSON.parse(text)),
	};
}

function refusalResult(refusal: Refusal): CallToolResult {
	return {
		isError: true,
		content: [
			{ type: "text", text: `${refusal.message} (${refusal.code})` },
			{ type: "text", text: refusal.remediation },
		],
	};
}

const FAILED: Refusal = {
	code: "HOBO_CI_MCP_FAILED",
	message: "the insight could not be read",
	remediation: "Retry; the relay's log names the cause.",
};

/** Run one tool as the caller, in the account's share of calls; a refusal is a tool error. */
async function asTool(
	services: RelayMcpInsightServices,
	name: string,
	extra: Extra,
	run: (accountId: string) => Promise<string>,
): Promise<CallToolResult> {
	let accountId: string | undefined;
	try {
		const caller = callerOf(extra);
		if (!caller.scopes.includes(RELAY_MCP_INSIGHT_SCOPE))
			throw refused(
				"HOBO_CI_MCP_SCOPE_REQUIRED",
				`account scope required: ${RELAY_MCP_INSIGHT_SCOPE}`,
				"Use a token that holds the read scope.",
			);
		if (services.beginCall && !services.beginCall(caller.accountId))
			throw refused(
				"HOBO_CI_MCP_BUSY",
				"too many calls in progress for this account",
				"Retry when one has finished.",
			);
		accountId = caller.accountId;
		return answer(await run(caller.accountId));
	} catch (error) {
		if (error instanceof InsightRefusal) return refusalResult(error.refusal);
		reportRelayFailure(
			"hobo_ci_mcp_insight_failed",
			{ tool: name },
			error instanceof Error ? error : undefined,
		);
		return refusalResult(FAILED);
	} finally {
		if (accountId !== undefined) services.endCall?.(accountId);
	}
}

/** The repository as the account connected it, or a refusal. */
async function connected(
	services: RelayMcpInsightServices,
	accountId: string,
	repository: string,
): Promise<Readonly<{ name: string; visibility: RepositoryVisibility }>> {
	const name = repository.toLowerCase();
	const visibility = (await services.repositories(accountId)).get(name);
	if (visibility === undefined)
		throw refused(
			"HOBO_CI_MCP_REPOSITORY_NOT_CONNECTED",
			`${repository} is not connected to this account`,
			"Name a repository the account connected to the relay.",
		);
	return { name, visibility };
}

/** The account's run attempts of one repository over the last `days`, newest first. */
async function recentRuns(
	services: RelayMcpInsightServices,
	repository: string,
	days: number | undefined,
	instead: string,
): Promise<Readonly<{ runs: readonly InsightRun[]; truncated: boolean }>> {
	if (!services.runs) throw notStored("run history", instead);
	const runs = await services.runs.runs({
		repository,
		sinceMs: services.now() - (days ?? RELAY_MCP_INSIGHT_DEFAULT_DAYS) * DAY_MS,
		limit: RELAY_MCP_INSIGHT_RUNS,
	});
	return { runs, truncated: runs.length >= RELAY_MCP_INSIGHT_RUNS };
}

/** Collects the entries an explanation would journal; it records nothing anywhere. */
class KeptAside implements RouteJournal {
	readonly events: RunnerRouteEvent[] = [];
	async record(event: RunnerRouteEvent): Promise<void> {
		this.events.push(event);
	}
	async decisions(_query: RouteDecisionQuery) {
		return [];
	}
}

const Cursor = z.object({ atMs: z.number(), key: z.string().max(400) });

function encodeCursor(cursor: ActivityCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(text: string): ActivityCursor {
	try {
		return Cursor.parse(
			JSON.parse(Buffer.from(text, "base64url").toString("utf8")),
		);
	} catch {
		throw refused(
			"HOBO_CI_MCP_INVALID_CURSOR",
			"invalid cursor",
			"Pass the `next` of an earlier list_route_decisions result, or none to start from the newest.",
		);
	}
}

function machineView(advert: MachineAdvert, nowMs: number) {
	return {
		id: advert.id,
		name: advert.name,
		runsOn: advert.runsOn,
		labels: advert.labels,
		os: advert.os,
		arch: advert.arch,
		slots: advert.slots,
		busy: advert.busy,
		paused: advert.paused,
		online: machineOnline(advert, nowMs),
		sharing: advert.sharing,
		isolation: advert.isolation,
		owner: advert.ownerLogin,
		repository: advert.repository === "" ? undefined : advert.repository,
		lastSeenMs: advert.lastSeenMs,
	};
}

const Repository = z
	.string()
	.regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u)
	.describe("A connected repository as owner/name; case is ignored.");
const Days = z
	.number()
	.int()
	.min(1)
	.max(RELAY_MCP_INSIGHT_MAX_DAYS)
	.optional()
	.describe(
		`Days of history to read, ${RELAY_MCP_INSIGHT_DEFAULT_DAYS} when absent.`,
	);
const Ref = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[^\s@]+$/u)
	.optional()
	.describe("A branch, tag or commit; the default branch when absent.");
const InputText = z.string().max(500);
const RelayInputs = z
	.strictObject({
		fleet: InputText.optional(),
		machine: InputText.optional(),
		github: InputText.optional(),
		blacksmith: InputText.optional(),
		depot: InputText.optional(),
		namespace: InputText.optional(),
		warpbuild: InputText.optional(),
		ubicloud: InputText.optional(),
		boat: InputText.optional(),
		"runs-on": InputText.optional(),
		size: InputText.optional(),
		first: InputText.optional(),
	})
	.describe(
		"The relay job's `with:` inputs: labels per runner type (fleet, machine, github or a provider), and optionally size and first.",
	);

const readOnly = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

/**
 * Add the eight insight tools to a relay MCP server. Each reads the ports in
 * `services` as the caller the HTTP layer authenticated.
 */
export function registerRelayMcpInsightTools(
	server: McpServer,
	services: RelayMcpInsightServices,
): void {
	const [
		getRunnerOrder,
		explainRoute,
		listRouteDecisions,
		listMachines,
		getSignals,
		getJobTimes,
		getRunFailures,
		getUsage,
	] = RELAY_MCP_TOOLS;

	server.registerTool(
		getRunnerOrder,
		{
			title: "Get the runner order",
			description:
				"The runner order a connected repository has committed in .hobo/ci.json: the runner types a relay job tries, in order, with their limits. `problem` is the parser's sentence when the committed order does not parse; nothing is routed while it stands.",
			inputSchema: { repository: Repository, ref: Ref },
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, getRunnerOrder, extra, async (accountId) => {
				const { name } = await connected(services, accountId, input.repository);
				const lookup = await services.order.order(name, input.ref);
				return JSON.stringify({
					repository: name,
					ref: input.ref,
					problem: lookup.problem === "" ? undefined : lookup.problem,
					order: JSON.parse(toJsonString(RunnerOrderSchema, lookup.order)),
				});
			}),
	);

	server.registerTool(
		explainRoute,
		{
			title: "Explain a route",
			description:
				"Where a relay job with these inputs would run now, and why: the committed order walked with the facts true at this moment (machines, minutes, spend, provider health). It records nothing and changes nothing.",
			inputSchema: {
				repository: Repository,
				inputs: RelayInputs,
				event: z
					.string()
					.regex(/^[a-z_]{1,60}$/u)
					.optional()
					.describe("The GitHub event, push when absent."),
				fork: z
					.boolean()
					.optional()
					.describe("The run's head is a fork's pull request."),
				ref: Ref,
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, explainRoute, extra, async (accountId) => {
				const { name, visibility } = await connected(
					services,
					accountId,
					input.repository,
				);
				const kept = new KeptAside();
				const inputs = input.inputs;
				await answerRelayJob(
					create(RelayJobMessageSchema, {
						jobId: EXPLAIN_ID,
						planId: EXPLAIN_ID,
						repository: name,
						runId: 1,
						runAttempt: 1,
						job: EXPLAIN_ID,
						event: input.event ?? "push",
						private: visibility === "private",
						fork: input.fork ?? false,
						workflowRef:
							input.ref === undefined
								? ""
								: `${name}/.github/workflows/hobo-relay.yml@${input.ref}`,
						inputs: RELAY_JOB_INPUTS.flatMap((key) => {
							const value = inputs[key];
							return value === undefined ? [] : [{ name: key, value }];
						}),
					}),
					{
						order: services.order,
						facts: services.facts,
						journal: kept,
						nowMs: services.now(),
						mode: "relay",
						node: EXPLAIN_NODE,
						accountId,
						checks: undefined,
					},
				);
				const [entry] = activityFeed(kept.events).entries;
				return JSON.stringify({
					repository: name,
					outcome: entry?.outcome,
					runner: entry?.runner,
					step: entry?.step,
					machineId: entry?.machineId === "" ? undefined : entry?.machineId,
					unhealthyFallback: entry?.unhealthyFallback,
					reason: entry?.why,
					passedOver: entry?.passedOver,
					recorded: false,
				});
			}),
	);

	server.registerTool(
		listRouteDecisions,
		{
			title: "List route decisions",
			description:
				"The account's relay jobs from the route journal, newest first: where each ran, why, and every runner type passed over, in words. Pass the returned `next` as `cursor` for the next page.",
			inputSchema: {
				repository: Repository.optional(),
				outcome: z.enum(ACTIVITY_OUTCOMES).optional(),
				step: z
					.enum(RUNNER_STEP_KEYS)
					.optional()
					.describe("Only jobs this runner type took."),
				machineId: z.string().min(1).max(100).optional(),
				sinceHours: z
					.number()
					.int()
					.min(1)
					.max(RELAY_MCP_INSIGHT_MAX_DAYS * 24)
					.optional()
					.describe("Only the last hours; the journal keeps 90 days."),
				limit: z.number().int().min(1).max(ACTIVITY_PAGE_MAX).optional(),
				cursor: z.string().min(1).max(800).optional(),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, listRouteDecisions, extra, async (accountId) => {
				if (!services.journal)
					throw notStored(
						"route journal",
						"run hobo ci route in a checkout to see where one job would go",
					);
				if (input.repository !== undefined)
					await connected(services, accountId, input.repository);
				const page = await journalActivity(services.journal, accountId, {
					repository: input.repository,
					outcome: input.outcome,
					step: input.step,
					machineId: input.machineId,
					sinceMs:
						input.sinceHours === undefined
							? undefined
							: services.now() - input.sinceHours * HOUR_MS,
					limit: input.limit ?? 20,
					after:
						input.cursor === undefined ? undefined : decodeCursor(input.cursor),
				});
				return JSON.stringify({
					decisions: page.entries.map((entry) => ({
						repository: entry.repository,
						runId: entry.runId,
						runAttempt: entry.runAttempt,
						job: entry.job,
						atMs: entry.atMs,
						mode: entry.mode,
						outcome: entry.outcome,
						runner: entry.runner,
						step: entry.step,
						machineId: entry.machineId === "" ? undefined : entry.machineId,
						reason: entry.why,
						passedOver: entry.passedOver,
					})),
					next: page.next === undefined ? undefined : encodeCursor(page.next),
				});
			}),
	);

	server.registerTool(
		listMachines,
		{
			title: "List machines",
			description:
				"The account's connected machines: labels, slots in use, whether each is online (advertised in the last 90 seconds), paused, who it takes jobs from, and whether jobs run in a fresh container.",
			annotations: readOnly,
		},
		(extra) =>
			asTool(services, listMachines, extra, async (accountId) => {
				if (!services.machines)
					throw notStored(
						"machine registry",
						"run hobo ci machine status against a relay that keeps one",
					);
				const nowMs = services.now();
				return JSON.stringify({
					machines: (await services.machines.list(accountId)).map((advert) =>
						machineView(advert, nowMs),
					),
				});
			}),
	);

	server.registerTool(
		getSignals,
		{
			title: "Get CI signals",
			description:
				"The nine CI signals for a connected repository's recent runs (no concurrency group, same commit run twice, short jobs, queue waits, a slowest job holding a run up, flaky jobs, runner failures, docs-only changes, wide fan-out), each with the minutes it covers, whether it passes its threshold, and its worst offenders.",
			inputSchema: { repository: Repository, days: Days },
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, getSignals, extra, async (accountId) => {
				const { name } = await connected(services, accountId, input.repository);
				const read = await recentRuns(
					services,
					name,
					input.days,
					`run hobo ci signals in a checkout of ${name}`,
				);
				return JSON.stringify({
					repository: name,
					runs: read.runs.length,
					truncated: read.truncated,
					...ciSignals(read.runs),
				});
			}),
	);

	server.registerTool(
		getJobTimes,
		{
			title: "Get job times",
			description:
				"For a connected repository's recent runs: per runner, how many jobs it took or missed, their median wait and run time and success rate; per job, its median and 90th-percentile run time on each runner and how each compares with ubuntu-latest.",
			inputSchema: {
				repository: Repository,
				days: Days,
				job: z
					.string()
					.min(1)
					.max(200)
					.optional()
					.describe("Only jobs with this name."),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, getJobTimes, extra, async (accountId) => {
				const { name } = await connected(services, accountId, input.repository);
				const read = await recentRuns(
					services,
					name,
					input.days,
					`run hobo ci signals in a checkout of ${name}`,
				);
				return JSON.stringify({
					repository: name,
					runs: read.runs.length,
					truncated: read.truncated,
					runners: runnerTimes(read.runs, { nowMs: services.now() }),
					jobs: jobTimes(read.runs).filter(
						(times) => input.job === undefined || times.job === input.job,
					),
				});
			}),
	);

	server.registerTool(
		getRunFailures,
		{
			title: "Get a run's failures",
			description:
				"Why a run's jobs failed: for each failed job (at most five), the step that failed, an excerpt of its log when the relay can read it, the kind of failure and whether a re-run is likely to help, with the lines and step names that decided it. No model is asked.",
			inputSchema: {
				repository: Repository,
				runId: z.number().int().positive(),
				attempt: z
					.number()
					.int()
					.min(1)
					.max(1000)
					.optional()
					.describe("The run attempt; the latest stored when absent."),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, getRunFailures, extra, async (accountId) => {
				const { name } = await connected(services, accountId, input.repository);
				const instead = `run hobo ci diagnose ${input.runId} in a checkout of ${name}`;
				const read = await recentRuns(
					services,
					name,
					RELAY_MCP_INSIGHT_MAX_DAYS,
					instead,
				);
				const run = read.runs
					.filter(
						(found) =>
							found.id === input.runId &&
							(input.attempt === undefined || found.attempt === input.attempt),
					)
					.sort((left, right) => right.attempt - left.attempt)[0];
				if (!run)
					throw refused(
						"HOBO_CI_MCP_RUN_NOT_FOUND",
						`Run ${input.runId} of ${name} is not stored here`,
						`Instead, ${instead}.`,
					);
				const failed = run.jobs.filter(
					(job) =>
						job.conclusion === "failure" || job.conclusion === "timed_out",
				);
				const jobs = [];
				for (const job of failed.slice(0, RELAY_MCP_DIAGNOSED_JOBS)) {
					const logTail = await services.failureLogs
						?.logTail(name, job.id)
						.catch(() => undefined);
					const diagnosis = diagnoseFailure(
						logTail === undefined ? { job } : { job, logTail },
					);
					jobs.push({
						jobId: job.id,
						name: job.name,
						runner: runnerKey(job.labels),
						conclusion: job.conclusion,
						summary: summarizeDiagnosis(diagnosis),
						log: logTail === undefined ? "not-read" : "read",
						...diagnosis,
					});
				}
				return JSON.stringify({
					repository: name,
					runId: run.id,
					attempt: run.attempt,
					conclusion: run.conclusion,
					failedJobs: failed.length,
					jobs,
				});
			}),
	);

	server.registerTool(
		getUsage,
		{
			title: "Get Actions usage",
			description:
				"Where a connected repository's recent runs spent Actions minutes: billed minutes per runner type, minutes wasted by jobs under a minute, minutes kept off GitHub-hosted runners priced at GitHub's rate (the rate carries its page and the day it was read), per day, and the plan's included minutes when they can be read.",
			inputSchema: { repository: Repository, days: Days },
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, getUsage, extra, async (accountId) => {
				const { name, visibility } = await connected(
					services,
					accountId,
					input.repository,
				);
				const read = await recentRuns(
					services,
					name,
					input.days,
					`run hobo ci usage --source github in a checkout of ${name}`,
				);
				const owner = name.split("/")[0] ?? name;
				const included = await services.minutes
					?.usage(owner)
					.catch(() => undefined);
				return JSON.stringify({
					repository: name,
					runs: read.runs.length,
					truncated: read.truncated,
					...usageReport(read.runs, {
						githubRate: services.githubRate,
						included,
						publicRepositories: new Set(visibility === "public" ? [name] : []),
					}),
				});
			}),
	);
}
