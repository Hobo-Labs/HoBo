import {
	create,
	type DescField,
	type DescMessage,
	fromJsonString,
	ScalarType,
	toJson,
} from "@bufbuild/protobuf";
import {
	type InsightStore,
	type JobFact,
	JobFactSchema,
	type MachineAdvert,
	MachineAdvertSchema,
	type MachineRegistry,
	type MinutesReader,
	type RouteJournal,
	type RunFact,
	RunFactSchema,
	type RunnerOrder,
	RunnerOrderSchema,
	type RunnerOrderSource,
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
	runFactOf,
} from "@hobo/ci";
import {
	CI_SIGNAL_IDS,
	type InsightRun,
	jobTimes,
	runnerTimes,
	workflowTimes,
} from "@hobo/ci/insights";
import {
	SIGNAL_DIMENSIONS,
	signalBreakdown,
} from "@hobo/ci/insights/breakdown";
import { type MinuteRate, usageReport } from "@hobo/ci/insights/usage";
import { z } from "zod";
import type { ControlAuthenticator } from "./control-auth.js";

export const READ_API_SCOPE = "policy:read";
export const READ_API_PREFIX = "/v1/accounts/self";
export const READ_API_DEFAULT_LIMIT = 50;
export const READ_API_MAX_LIMIT = 200;
export const READ_API_MAX_OFFSET = 1000;
export const READ_API_LIST_WINDOW_MS = 90 * 86_400_000;
export const READ_API_REPORT_WINDOW_MS = 30 * 86_400_000;
export const READ_API_REPORT_RUN_CAP = 1000;
export const READ_API_MAX_REPOSITORIES = 50;

export type AccountRepository = Readonly<{
	name: string;
	public: boolean;
}>;

export type ReadApiDeps = Readonly<{
	authenticate: ControlAuthenticator;
	repositories: (accountId: string) => Promise<readonly AccountRepository[]>;
	order: RunnerOrderSource;
	journal: RouteJournal | undefined;
	machines: MachineRegistry | undefined;
	insights: InsightStore | undefined;
	minutes: MinutesReader | undefined;
	githubRate: MinuteRate;
	nowMs: () => number;
}>;

const count = z.number().int().min(0);
const ms = z.number();
const signalId = z.enum(CI_SIGNAL_IDS);

const SignalCountJson = z.object({
	id: signalId,
	minutes: z.number(),
	occurrences: count,
});
const SignalSliceJson = z.object({
	key: z.string(),
	runs: count,
	jobMinutes: z.number(),
	minutes: z.number(),
	signals: z.array(SignalCountJson),
});

export const SignalReportJson = z.object({
	sinceMs: ms,
	runs: count,
	signals: z.object({
		totalJobMinutes: z.number(),
		signals: z.array(
			z.object({
				id: signalId,
				area: z.enum(["cost", "speed", "complexity"]),
				minutes: z.number(),
				occurrences: count,
				shown: z.boolean(),
				rows: z.array(
					z.object({
						key: z.string(),
						minutes: z.number(),
						occurrences: count,
					}),
				),
			}),
		),
	}),
	by: z.object(
		Object.fromEntries(
			SIGNAL_DIMENSIONS.map((dimension) => [
				dimension,
				z.array(SignalSliceJson),
			]),
		),
	),
	trend: z.array(SignalSliceJson.extend({ day: z.string() })),
});
export type ReadApiSignalReport = z.infer<typeof SignalReportJson>;

const confidence = z.enum(["enough", "few", "sparse"]);

export const JobTimesReportJson = z.object({
	sinceMs: ms,
	runs: count,
	workflows: z.array(
		z.object({
			workflow: z.string(),
			runs: count,
			successRate: z.number().optional(),
			medianMs: z.number().optional(),
			p90Ms: z.number().optional(),
			medianWaitMs: z.number().optional(),
			slowestJob: z.string().optional(),
		}),
	),
	jobs: z.array(
		z.object({
			job: z.string(),
			workflow: z.string(),
			runners: z.array(
				z.object({
					key: z.string(),
					runs: count,
					medianRunMs: z.number(),
					p90RunMs: z.number(),
					confidence,
				}),
			),
			fastest: z.string().optional(),
			speedup: z.array(z.object({ key: z.string(), ratio: z.number() })),
		}),
	),
	runners: z.array(
		z.object({
			key: z.string(),
			jobs: count,
			started: count,
			startedShare: z.number(),
			medianWaitMs: z.number().optional(),
			medianRunMs: z.number().optional(),
			p90RunMs: z.number().optional(),
			successRate: z.number().optional(),
		}),
	),
});
export type ReadApiJobTimesReport = z.infer<typeof JobTimesReportJson>;

const usageTotals = {
	jobs: count,
	billedMinutes: z.number(),
	shortJobs: count,
	wasteMinutes: z.number(),
	keptMinutes: z.number(),
	keptUsd: z.number(),
	relayJobsAnswered: count,
	relaySavedMinutes: z.number(),
	relaySavedUsd: z.number(),
};

export const UsageReportJson = z.object({
	sinceMs: ms,
	runs: count,
	...usageTotals,
	rate: z.object({
		usdPerMinute: z.number(),
		source: z.string(),
		readOn: z.string(),
	}),
	runners: z.array(
		z.object({ runner: z.string(), hosted: z.boolean(), ...usageTotals }),
	),
	days: z.array(z.object({ day: z.string(), ...usageTotals })),
	included: z
		.object({
			usedMinutes: z.number(),
			includedMinutes: z.number(),
			remainingMinutes: z.number(),
			burnPerDay: z.number(),
			daysLeft: z.number().optional(),
		})
		.optional(),
});
export type ReadApiUsageReport = z.infer<typeof UsageReportJson>;

export const ReadApiErrorJson = z.object({
	error: z.string(),
	code: z.enum([
		"unauthenticated",
		"forbidden",
		"method-not-allowed",
		"bad-request",
		"not-found",
		"not-stored-here",
	]),
	command: z.string().optional(),
});
export type ReadApiErrorCode = z.infer<typeof ReadApiErrorJson>["code"];

export type ReadApiParameter = Readonly<{
	name: "repository" | "ref" | "since" | "limit" | "cursor";
	required: boolean;
	description: string;
}>;

export type ReadApiAnswer =
	| Readonly<{ kind: "page"; field: string; record: DescMessage }>
	| Readonly<{ kind: "order" }>
	| Readonly<{ kind: "report"; name: string; schema: z.ZodType }>;

export type ReadApiRoute = Readonly<{
	path: string;
	operationId: string;
	summary: string;
	parameters: readonly ReadApiParameter[];
	answer: ReadApiAnswer;
	stored:
		| Readonly<{ store: "journal" | "machines" | "insights"; command: string }>
		| undefined;
}>;

const repositoryParameter = (required: boolean): ReadApiParameter => ({
	name: "repository",
	required,
	description: required
		? "The connected repository, `owner/name`."
		: "One connected repository, `owner/name`; every connected repository when absent.",
});
const sinceParameter = (window: string): ReadApiParameter => ({
	name: "since",
	required: false,
	description: `Epoch milliseconds; rows at or after it. Default: ${window} ago.`,
});
const pageParameters: readonly ReadApiParameter[] = [
	{
		name: "limit",
		required: false,
		description: `Rows per page, 1 to ${READ_API_MAX_LIMIT}. Default ${READ_API_DEFAULT_LIMIT}.`,
	},
	{
		name: "cursor",
		required: false,
		description: "The `next` value of the previous page.",
	},
];

export const READ_API_ROUTES: readonly ReadApiRoute[] = [
	{
		path: "/runner-order",
		operationId: "getRunnerOrder",
		summary:
			"The runner order a connected repository has committed, and the parser's sentence when it does not parse.",
		parameters: [
			repositoryParameter(true),
			{
				name: "ref",
				required: false,
				description: "A git ref or commit; the default branch when absent.",
			},
		],
		answer: { kind: "order" },
		stored: undefined,
	},
	{
		path: "/routes",
		operationId: "listRouteDecisions",
		summary: "Route journal entries, newest first.",
		parameters: [
			repositoryParameter(false),
			sinceParameter("90 days"),
			...pageParameters,
		],
		answer: { kind: "page", field: "routes", record: RunnerRouteEventSchema },
		stored: { store: "journal", command: "hobo ci route" },
	},
	{
		path: "/machines",
		operationId: "listMachines",
		summary: "The account's connected machines, in id order.",
		parameters: pageParameters,
		answer: { kind: "page", field: "machines", record: MachineAdvertSchema },
		stored: { store: "machines", command: "hobo ci runners list" },
	},
	{
		path: "/runs",
		operationId: "listRuns",
		summary:
			"Stored run attempts, newest first, without their jobs (read them from `/runs/{id}/{attempt}/jobs`).",
		parameters: [
			repositoryParameter(false),
			sinceParameter("90 days"),
			...pageParameters,
		],
		answer: { kind: "page", field: "runs", record: RunFactSchema },
		stored: { store: "insights", command: "gh run list" },
	},
	{
		path: "/runs/{id}/{attempt}/jobs",
		operationId: "listRunJobs",
		summary: "The jobs of one stored run attempt, with their steps.",
		parameters: [repositoryParameter(false), ...pageParameters],
		answer: { kind: "page", field: "jobs", record: JobFactSchema },
		stored: {
			store: "insights",
			command: "gh run view <id> --attempt <attempt>",
		},
	},
	{
		path: "/signals",
		operationId: "getSignals",
		summary:
			"The nine signals over stored runs, with a breakdown by person, repository, workflow, branch and event, and a per-day trend.",
		parameters: [repositoryParameter(false), sinceParameter("30 days")],
		answer: { kind: "report", name: "SignalReport", schema: SignalReportJson },
		stored: { store: "insights", command: "hobo ci signals" },
	},
	{
		path: "/job-times",
		operationId: "getJobTimes",
		summary:
			"Times by workflow, job and runner over stored runs, each runner against ubuntu-latest.",
		parameters: [repositoryParameter(false), sinceParameter("30 days")],
		answer: {
			kind: "report",
			name: "JobTimesReport",
			schema: JobTimesReportJson,
		},
		stored: {
			store: "insights",
			command: "hobo ci performance --source github",
		},
	},
	{
		path: "/usage",
		operationId: "getUsage",
		summary:
			"Billed minutes per runner and day, short jobs, minutes kept off GitHub-hosted runners, and the included minutes left.",
		parameters: [repositoryParameter(false), sinceParameter("30 days")],
		answer: { kind: "report", name: "UsageReport", schema: UsageReportJson },
		stored: { store: "insights", command: "hobo ci usage --source github" },
	},
];

class ReadApiRefusal extends Error {
	constructor(
		readonly status: number,
		readonly code: ReadApiErrorCode,
		message: string,
		readonly command: string | undefined = undefined,
	) {
		super(message);
	}
}

const JOBS_PATH = /^\/runs\/(\d{1,16})\/(\d{1,6})\/jobs$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const DIGITS = /^\d{1,16}$/u;

type Matched = Readonly<{
	route: ReadApiRoute;
	run: Readonly<{ id: number; attempt: number }> | undefined;
}>;

function matchRoute(path: string): Matched | undefined {
	if (!path.startsWith(`${READ_API_PREFIX}/`)) return undefined;
	const rest = path.slice(READ_API_PREFIX.length);
	const jobs = JOBS_PATH.exec(rest);
	if (jobs?.[1] && jobs[2]) {
		const route = READ_API_ROUTES.find(
			(entry) => entry.answer.kind === "page" && entry.answer.field === "jobs",
		);
		return route
			? { route, run: { id: Number(jobs[1]), attempt: Number(jobs[2]) } }
			: undefined;
	}
	const route = READ_API_ROUTES.find((entry) => entry.path === rest);
	return route ? { route, run: undefined } : undefined;
}

function json(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});
}

function refusal(error: ReadApiRefusal): Response {
	const body: z.infer<typeof ReadApiErrorJson> =
		error.command === undefined
			? { error: error.message, code: error.code }
			: { error: error.message, code: error.code, command: error.command };
	return json(error.status, JSON.stringify(body));
}

function badRequest(message: string): ReadApiRefusal {
	return new ReadApiRefusal(400, "bad-request", message);
}

type Query = Readonly<{
	repository: string | undefined;
	ref: string | undefined;
	since: number | undefined;
	limit: number;
	offset: number;
}>;

function integerParameter(
	params: URLSearchParams,
	name: string,
): number | undefined {
	const value = params.get(name);
	if (value === null) return undefined;
	if (!DIGITS.test(value) || !Number.isSafeInteger(Number(value)))
		throw badRequest(`${name} must be a non-negative whole number`);
	return Number(value);
}

function parseQuery(route: ReadApiRoute, params: URLSearchParams): Query {
	const allowed = new Set<string>(
		route.parameters.map((parameter) => parameter.name),
	);
	for (const name of params.keys())
		if (!allowed.has(name)) throw badRequest(`unknown parameter ${name}`);
	const repository = params.get("repository") ?? undefined;
	if (repository !== undefined && !REPOSITORY.test(repository))
		throw badRequest("repository must be owner/name");
	if (
		repository === undefined &&
		route.parameters.some(
			(parameter) => parameter.name === "repository" && parameter.required,
		)
	)
		throw badRequest("repository is required");
	const ref = params.get("ref") ?? undefined;
	if (ref !== undefined && (ref.length === 0 || ref.length > 255))
		throw badRequest("ref must be 1 to 255 characters");
	const limit = integerParameter(params, "limit") ?? READ_API_DEFAULT_LIMIT;
	if (limit < 1 || limit > READ_API_MAX_LIMIT)
		throw badRequest(`limit must be 1 to ${READ_API_MAX_LIMIT}`);
	const offset = integerParameter(params, "cursor") ?? 0;
	if (offset + limit > READ_API_MAX_OFFSET)
		throw badRequest(
			`a page may not reach past row ${READ_API_MAX_OFFSET}; narrow it with since`,
		);
	return {
		repository,
		ref,
		since: integerParameter(params, "since"),
		limit,
		offset,
	};
}

async function coveredRepositories(
	deps: ReadApiDeps,
	accountId: string,
	repository: string | undefined,
): Promise<readonly AccountRepository[]> {
	const connected = await deps.repositories(accountId);
	if (repository === undefined)
		return connected.slice(0, READ_API_MAX_REPOSITORIES);
	const wanted = repository.toLowerCase();
	const match = connected.find((entry) => entry.name.toLowerCase() === wanted);
	if (!match)
		throw new ReadApiRefusal(
			404,
			"not-found",
			"repository not connected to this account",
		);
	return [match];
}

function page<T>(rows: readonly T[], query: Query): ReadApiPage<T> {
	const end = query.offset + query.limit;
	return {
		rows: rows.slice(query.offset, end),
		next: rows.length > end ? String(end) : undefined,
	};
}

function pageBody(
	field: string,
	rows: readonly string[],
	next: string | undefined,
): string {
	const tail = next === undefined ? "" : `,"next":${JSON.stringify(next)}`;
	return `{${JSON.stringify(field)}:[${rows.join(",")}]${tail}}`;
}

async function storedRuns(
	store: InsightStore,
	repositories: readonly AccountRepository[],
	sinceMs: number,
	depth: number,
): Promise<readonly InsightRun[]> {
	const runs = (
		await Promise.all(
			repositories.map((repository) =>
				store.runs({ repository: repository.name, sinceMs, limit: depth }),
			),
		)
	).flat();
	return runs
		.sort(
			(left, right) =>
				right.createdAtMs - left.createdAtMs ||
				right.id - left.id ||
				right.attempt - left.attempt ||
				(left.repository < right.repository ? -1 : 1),
		)
		.slice(0, depth);
}

function withoutJobs(run: InsightRun): RunFact {
	return create(RunFactSchema, { ...runFactOf(run), jobs: [] });
}

function soleOwner(
	repositories: readonly AccountRepository[],
): string | undefined {
	const owners = new Set(
		repositories.map(
			(repository) => repository.name.split("/")[0]?.toLowerCase() ?? "",
		),
	);
	return owners.size === 1 ? [...owners][0] : undefined;
}

async function answer(
	deps: ReadApiDeps,
	accountId: string,
	matched: Matched,
	query: Query,
): Promise<string> {
	const { route } = matched;
	const nowMs = deps.nowMs();
	const depth = query.offset + query.limit + 1;
	const listSince = query.since ?? nowMs - READ_API_LIST_WINDOW_MS;
	const reportSince = query.since ?? nowMs - READ_API_REPORT_WINDOW_MS;
	switch (route.operationId) {
		case "getRunnerOrder": {
			const [repository] = await coveredRepositories(
				deps,
				accountId,
				query.repository,
			);
			const name = repository?.name ?? "";
			const lookup = await deps.order.order(name, query.ref);
			const order: RunnerOrder = lookup.order;
			return JSON.stringify({
				repository: name,
				...(query.ref === undefined ? undefined : { ref: query.ref }),
				order: toJson(RunnerOrderSchema, order),
				...(lookup.problem === "" ? undefined : { problem: lookup.problem }),
			});
		}
		case "listRouteDecisions": {
			const journal = stored(deps.journal, route);
			if (query.repository !== undefined)
				await coveredRepositories(deps, accountId, query.repository);
			const events: readonly RunnerRouteEvent[] = await journal.decisions({
				accountId,
				repository: query.repository,
				sinceMs: listSince,
				limit: depth,
			});
			const { rows, next } = page(
				events.filter((event) => event.accountId === accountId),
				query,
			);
			return pageBody(
				"routes",
				rows.map((event) =>
					JSON.stringify(toJson(RunnerRouteEventSchema, event)),
				),
				next,
			);
		}
		case "listMachines": {
			const registry = stored(deps.machines, route);
			const machines: readonly MachineAdvert[] = (
				await registry.list(accountId)
			).filter((machine) => machine.accountId === accountId);
			const { rows, next } = page(machines, query);
			return pageBody(
				"machines",
				rows.map((machine) =>
					JSON.stringify(toJson(MachineAdvertSchema, machine)),
				),
				next,
			);
		}
		case "listRuns": {
			const store = stored(deps.insights, route);
			const repositories = await coveredRepositories(
				deps,
				accountId,
				query.repository,
			);
			const runs = await storedRuns(store, repositories, listSince, depth);
			const { rows, next } = page(runs, query);
			return pageBody(
				"runs",
				rows.map((run) =>
					JSON.stringify(toJson(RunFactSchema, withoutJobs(run))),
				),
				next,
			);
		}
		case "listRunJobs": {
			const store = stored(deps.insights, route);
			const repositories = await coveredRepositories(
				deps,
				accountId,
				query.repository,
			);
			const wanted = matched.run;
			const runs = await storedRuns(
				store,
				repositories,
				nowMs - READ_API_LIST_WINDOW_MS,
				READ_API_REPORT_RUN_CAP,
			);
			const run = runs.find(
				(entry) => entry.id === wanted?.id && entry.attempt === wanted.attempt,
			);
			if (!run)
				throw new ReadApiRefusal(404, "not-found", "run attempt not stored");
			const jobs: readonly JobFact[] = runFactOf(run).jobs;
			const { rows, next } = page(jobs, query);
			return pageBody(
				"jobs",
				rows.map((job) => JSON.stringify(toJson(JobFactSchema, job))),
				next,
			);
		}
		default:
			return report(deps, accountId, route, query, reportSince);
	}
}

async function report(
	deps: ReadApiDeps,
	accountId: string,
	route: ReadApiRoute,
	query: Query,
	sinceMs: number,
): Promise<string> {
	const store = stored(deps.insights, route);
	const repositories = await coveredRepositories(
		deps,
		accountId,
		query.repository,
	);
	const runs = await storedRuns(
		store,
		repositories,
		sinceMs,
		READ_API_REPORT_RUN_CAP * Math.max(1, repositories.length),
	);
	const head = { sinceMs, runs: runs.length };
	if (route.operationId === "getSignals") {
		const breakdown = signalBreakdown(runs);
		return JSON.stringify({
			...head,
			signals: breakdown.signals,
			by: breakdown.by,
			trend: breakdown.trend,
		});
	}
	if (route.operationId === "getJobTimes")
		return JSON.stringify({
			...head,
			workflows: workflowTimes(runs),
			jobs: jobTimes(runs),
			runners: runnerTimes(runs, { nowMs: deps.nowMs() }),
		});
	const owner = soleOwner(repositories);
	const included =
		owner === undefined ? undefined : await deps.minutes?.usage(owner);
	return JSON.stringify({
		...head,
		...usageReport(runs, {
			githubRate: deps.githubRate,
			included,
			publicRepositories: new Set(
				repositories
					.filter((repository) => repository.public)
					.map((repository) => repository.name),
			),
		}),
	});
}

function storeName(route: ReadApiRoute): string {
	switch (route.stored?.store) {
		case "journal":
			return "route journal";
		case "machines":
			return "machine registry";
		default:
			return "run history";
	}
}

function stored<T>(store: T | undefined, route: ReadApiRoute): T {
	if (store !== undefined) return store;
	const command = route.stored?.command ?? "";
	throw new ReadApiRefusal(
		404,
		"not-stored-here",
		`not stored here: this relay keeps no ${storeName(route)}; read GitHub with \`${command}\``,
		command,
	);
}

export function createReadApi(
	deps: ReadApiDeps,
): (request: Request) => Promise<Response | undefined> {
	return async (request) => {
		const url = new URL(request.url);
		const matched = matchRoute(url.pathname);
		if (!matched) return undefined;
		try {
			if (request.method !== "GET")
				throw new ReadApiRefusal(
					405,
					"method-not-allowed",
					"the read API answers GET only",
				);
			const principal = await deps.authenticate(
				request.headers.get("authorization") ?? undefined,
			);
			if (!principal)
				throw new ReadApiRefusal(
					401,
					"unauthenticated",
					"account authentication required",
				);
			if (!principal.scopes.includes(READ_API_SCOPE))
				throw new ReadApiRefusal(
					403,
					"forbidden",
					`account scope required: ${READ_API_SCOPE}`,
				);
			const query = parseQuery(matched.route, url.searchParams);
			return json(200, await answer(deps, principal.accountId, matched, query));
		} catch (error) {
			if (error instanceof ReadApiRefusal) return refusal(error);
			throw error;
		}
	};
}

type JsonSchema = z.core.JSONSchema.JSONSchema;

const COMPONENT = "#/components/schemas/";

function scalarSchema(scalar: ScalarType): JsonSchema {
	switch (scalar) {
		case ScalarType.STRING:
			return { type: "string" };
		case ScalarType.BOOL:
			return { type: "boolean" };
		case ScalarType.BYTES:
			return { type: "string", contentEncoding: "base64" };
		case ScalarType.DOUBLE:
		case ScalarType.FLOAT:
			return { type: "number" };
		case ScalarType.INT32:
		case ScalarType.UINT32:
		case ScalarType.SINT32:
		case ScalarType.FIXED32:
		case ScalarType.SFIXED32:
			return { type: "integer" };
		default:
			return { type: "string", pattern: "^-?[0-9]+$" };
	}
}

function protobufJsonSchemas(
	roots: readonly DescMessage[],
): ReadonlyMap<string, JsonSchema> {
	const schemas = new Map<string, JsonSchema>();
	const value = (field: DescField): JsonSchema => {
		if (field.message) {
			visit(field.message);
			return { $ref: `${COMPONENT}${field.message.name}` };
		}
		if (field.enum)
			return {
				type: "string",
				enum: field.enum.values.map((entry) => entry.name),
			};
		return scalarSchema(field.scalar ?? ScalarType.STRING);
	};
	const fieldSchema = (field: DescField): JsonSchema => {
		if (field.fieldKind === "list")
			return { type: "array", items: value(field) };
		if (field.fieldKind === "map")
			return { type: "object", additionalProperties: value(field) };
		return value(field);
	};
	function visit(message: DescMessage): void {
		if (schemas.has(message.name)) return;
		schemas.set(message.name, {});
		schemas.set(message.name, {
			type: "object",
			description: `\`${message.typeName}\` as protobuf JSON.`,
			properties: Object.fromEntries(
				message.fields.map((field): [string, JsonSchema] => [
					field.jsonName,
					fieldSchema(field),
				]),
			),
			additionalProperties: false,
		});
	}
	for (const root of roots) visit(root);
	return schemas;
}

function zodJsonSchema(schema: z.ZodType): JsonSchema {
	const generated = z.toJSONSchema(schema, { io: "output" });
	delete generated.$schema;
	return generated;
}

function okSchema(route: ReadApiRoute): JsonSchema {
	const { answer } = route;
	if (answer.kind === "report") return { $ref: `${COMPONENT}${answer.name}` };
	if (answer.kind === "order")
		return {
			type: "object",
			required: ["repository", "order"],
			properties: {
				repository: { type: "string" },
				ref: { type: "string" },
				order: { $ref: `${COMPONENT}RunnerOrder` },
				problem: {
					type: "string",
					description:
						"The parser's sentence when the committed order does not parse; `order` is then the default, which nothing walks.",
				},
			},
			additionalProperties: false,
		};
	return {
		type: "object",
		required: [answer.field],
		properties: {
			[answer.field]: {
				type: "array",
				items: { $ref: `${COMPONENT}${answer.record.name}` },
			},
			next: {
				type: "string",
				description: "Pass as `cursor` for the next page; absent on the last.",
			},
		},
		additionalProperties: false,
	};
}

const ERROR_STATUSES: readonly (readonly [string, string])[] = [
	["400", "A parameter is missing or malformed."],
	["401", "No account token, or one the relay does not know."],
	["403", `The token lacks the ${READ_API_SCOPE} scope.`],
	[
		"404",
		"Not found, not this account's, or `not-stored-here` with the command that reads GitHub instead.",
	],
	["405", "The read API answers GET only."],
];

export function readApiOpenApi(): string {
	const records = protobufJsonSchemas([
		RunnerOrderSchema,
		...READ_API_ROUTES.flatMap((route) =>
			route.answer.kind === "page" ? [route.answer.record] : [],
		),
	]);
	const reports = READ_API_ROUTES.flatMap((route): [string, JsonSchema][] =>
		route.answer.kind === "report"
			? [[route.answer.name, zodJsonSchema(route.answer.schema)]]
			: [],
	);
	const errorContent = {
		"application/json": { schema: { $ref: `${COMPONENT}ReadApiError` } },
	};
	const paths = READ_API_ROUTES.map((route) => {
		const pathParameters = [...route.path.matchAll(/\{(\w+)\}/gu)].map(
			(match) => ({
				name: match[1] ?? "",
				in: "path",
				required: true,
				schema: { type: "string", pattern: "^[0-9]+$" },
			}),
		);
		const queryParameters = route.parameters.map((parameter) => ({
			name: parameter.name,
			in: "query",
			required: parameter.required,
			description: parameter.description,
			schema:
				parameter.name === "since" ||
				parameter.name === "limit" ||
				parameter.name === "cursor"
					? { type: "string", pattern: "^[0-9]+$" }
					: { type: "string" },
		}));
		const notStored =
			route.stored === undefined
				? ""
				: ` A host that keeps no ${storeName(route)} answers 404 \`not-stored-here\` naming \`${route.stored.command}\`.`;
		const responses = [
			[
				"200",
				{
					description: "The account's rows.",
					content: { "application/json": { schema: okSchema(route) } },
				},
			],
			...ERROR_STATUSES.map(([status, description]) => [
				status,
				{ description, content: errorContent },
			]),
		];
		return [
			`${READ_API_PREFIX}${route.path}`,
			{
				get: {
					operationId: route.operationId,
					summary: route.summary,
					description: `Needs the \`${READ_API_SCOPE}\` scope and answers only the token's account.${notStored}`,
					parameters: [...pathParameters, ...queryParameters],
					responses: Object.fromEntries(responses),
				},
			},
		];
	});
	const document = {
		openapi: "3.1.0",
		info: {
			title: "HoBo CI relay read API",
			version: "1",
			description:
				"What a HoBo CI relay keeps about one account: its runner order, route decisions, machines, runs and jobs, and the signal, job-time and usage reports computed from stored runs (ADR-0183). Generated from `READ_API_ROUTES` in `src/read-api.ts`; do not edit.",
		},
		security: [{ accountToken: [] }],
		paths: Object.fromEntries(paths),
		components: {
			securitySchemes: {
				accountToken: {
					type: "http",
					scheme: "bearer",
					description: `An account token holding the \`${READ_API_SCOPE}\` scope.`,
				},
			},
			schemas: Object.fromEntries([
				...records,
				...reports,
				["ReadApiError", zodJsonSchema(ReadApiErrorJson)],
			]),
		},
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}

export class ReadApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly command: string | undefined,
	) {
		super(message);
		this.name = "ReadApiError";
	}
}

export type ReadApiListOptions = Readonly<{
	repository?: string;
	since?: number;
	limit?: number;
	cursor?: string;
}>;

export type ReadApiReportOptions = Readonly<{
	repository?: string;
	since?: number;
}>;

export type ReadApiPage<T> = Readonly<{
	rows: readonly T[];
	next: string | undefined;
}>;

export type RunnerOrderReply = Readonly<{
	repository: string;
	ref: string | undefined;
	order: RunnerOrder;
	problem: string;
}>;

const PageJson = z.object({
	routes: z.array(z.json()).optional(),
	machines: z.array(z.json()).optional(),
	runs: z.array(z.json()).optional(),
	jobs: z.array(z.json()).optional(),
	next: z.string().optional(),
});
const OrderJson = z.object({
	repository: z.string(),
	ref: z.string().optional(),
	order: z.json(),
	problem: z.string().optional(),
});

type QueryValues = ReadonlyMap<string, string | number | undefined>;

export class ReadApiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	private async get(path: string, params: QueryValues): Promise<string> {
		const url = new URL(`${READ_API_PREFIX}${path}`, this.baseUrl);
		for (const [name, value] of params)
			if (value !== undefined) url.searchParams.set(name, String(value));
		const response = await this.fetcher(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${this.token}`,
			},
		});
		const text = await response.text();
		if (response.ok) return text;
		const refused = ReadApiErrorJson.safeParse(jsonOrUndefined(text));
		if (refused.success)
			throw new ReadApiError(
				response.status,
				refused.data.code,
				refused.data.error,
				refused.data.command,
			);
		throw new ReadApiError(
			response.status,
			"unexpected",
			`read API answered ${response.status}`,
			undefined,
		);
	}

	private async list(
		path: string,
		options: ReadApiListOptions,
	): Promise<z.infer<typeof PageJson>> {
		const text = await this.get(
			path,
			new Map<string, string | number | undefined>([
				["repository", options.repository],
				["since", options.since],
				["limit", options.limit],
				["cursor", options.cursor],
			]),
		);
		return PageJson.parse(JSON.parse(text));
	}

	private async report(
		path: string,
		options: ReadApiReportOptions,
	): Promise<z.core.util.JSONType> {
		const text = await this.get(
			path,
			new Map<string, string | number | undefined>([
				["repository", options.repository],
				["since", options.since],
			]),
		);
		return z.json().parse(JSON.parse(text));
	}

	async runnerOrder(
		repository: string,
		ref: string | undefined = undefined,
	): Promise<RunnerOrderReply> {
		const text = await this.get(
			"/runner-order",
			new Map([
				["repository", repository],
				["ref", ref],
			]),
		);
		const body = OrderJson.parse(JSON.parse(text));
		return {
			repository: body.repository,
			ref: body.ref,
			order: fromJsonString(RunnerOrderSchema, JSON.stringify(body.order)),
			problem: body.problem ?? "",
		};
	}

	async routes(
		options: ReadApiListOptions = {},
	): Promise<ReadApiPage<RunnerRouteEvent>> {
		const body = await this.list("/routes", options);
		return {
			rows: (body.routes ?? []).map((row) =>
				fromJsonString(RunnerRouteEventSchema, JSON.stringify(row)),
			),
			next: body.next,
		};
	}

	async machines(
		options: ReadApiListOptions = {},
	): Promise<ReadApiPage<MachineAdvert>> {
		const body = await this.list("/machines", options);
		return {
			rows: (body.machines ?? []).map((row) =>
				fromJsonString(MachineAdvertSchema, JSON.stringify(row)),
			),
			next: body.next,
		};
	}

	async runs(options: ReadApiListOptions = {}): Promise<ReadApiPage<RunFact>> {
		const body = await this.list("/runs", options);
		return {
			rows: (body.runs ?? []).map((row) =>
				fromJsonString(RunFactSchema, JSON.stringify(row)),
			),
			next: body.next,
		};
	}

	async jobs(
		runId: number,
		attempt: number,
		options: ReadApiListOptions = {},
	): Promise<ReadApiPage<JobFact>> {
		const body = await this.list(`/runs/${runId}/${attempt}/jobs`, options);
		return {
			rows: (body.jobs ?? []).map((row) =>
				fromJsonString(JobFactSchema, JSON.stringify(row)),
			),
			next: body.next,
		};
	}

	async signals(
		options: ReadApiReportOptions = {},
	): Promise<ReadApiSignalReport> {
		return SignalReportJson.parse(await this.report("/signals", options));
	}

	async jobTimes(
		options: ReadApiReportOptions = {},
	): Promise<ReadApiJobTimesReport> {
		return JobTimesReportJson.parse(await this.report("/job-times", options));
	}

	async usage(options: ReadApiReportOptions = {}): Promise<ReadApiUsageReport> {
		return UsageReportJson.parse(await this.report("/usage", options));
	}
}

function jsonOrUndefined(text: string): z.core.util.JSONType | undefined {
	try {
		return z.json().parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}
