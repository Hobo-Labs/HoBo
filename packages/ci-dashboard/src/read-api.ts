import type { MachineAdvert, RunFact, RunnerRouteEvent } from "@hobo/ci";
import {
	DEFAULT_RUNNER_ORDER,
	type ParsedRunnerOrder,
	parseMachineAdvert,
	parseRunFact,
	parseRunnerOrder,
	parseRunnerRouteEvent,
} from "@hobo/ci/runner-order";
import { z } from "zod/mini";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

export const READ_API_PREFIX = "/v1/accounts/self";
export const DASHBOARD_PAGE_LIMIT = 50;

export class DashboardApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly command: string | undefined,
	) {
		super(message);
		this.name = "DashboardApiError";
	}
}

export type OrderReply = Readonly<{
	repository: string;
	ref: string | undefined;
	order: ParsedRunnerOrder;
	problem: string;
}>;

const ErrorJson = z.object({
	error: z.string(),
	code: z.string(),
	command: z.optional(z.string()),
});

const PageJson = z.object({
	routes: z.optional(z.array(z.json())),
	machines: z.optional(z.array(z.json())),
	runs: z.optional(z.array(z.json())),
	jobs: z.optional(z.array(z.json())),
	next: z.optional(z.string()),
});

const OrderJson = z.object({
	repository: z.string(),
	ref: z.optional(z.string()),
	order: z.json(),
	problem: z.optional(z.string()),
});

const SliceJson = z.object({
	key: z.string(),
	runs: z.number(),
	minutes: z.number(),
	jobMinutes: z.number(),
});

export const SignalReportJson = z.object({
	sinceMs: z.number(),
	runs: z.number(),
	signals: z.object({
		totalJobMinutes: z.number(),
		signals: z.array(
			z.object({
				id: z.string(),
				area: z.string(),
				minutes: z.number(),
				occurrences: z.number(),
				shown: z.boolean(),
				rows: z.array(
					z.object({
						key: z.string(),
						minutes: z.number(),
						occurrences: z.number(),
					}),
				),
			}),
		),
	}),
	by: z.record(z.string(), z.array(SliceJson)),
	trend: z.array(z.extend(SliceJson, { day: z.string() })),
});
export type SignalReport = z.infer<typeof SignalReportJson>;

export const JobTimesReportJson = z.object({
	sinceMs: z.number(),
	runs: z.number(),
	workflows: z.array(
		z.object({
			workflow: z.string(),
			runs: z.number(),
			successRate: z.optional(z.number()),
			medianMs: z.optional(z.number()),
			p90Ms: z.optional(z.number()),
			medianWaitMs: z.optional(z.number()),
			slowestJob: z.optional(z.string()),
		}),
	),
	jobs: z.array(
		z.object({
			job: z.string(),
			workflow: z.string(),
			runners: z.array(
				z.object({
					key: z.string(),
					runs: z.number(),
					medianRunMs: z.number(),
					p90RunMs: z.number(),
					confidence: z.string(),
				}),
			),
			fastest: z.optional(z.string()),
			speedup: z.array(z.object({ key: z.string(), ratio: z.number() })),
		}),
	),
	runners: z.array(
		z.object({
			key: z.string(),
			jobs: z.number(),
			started: z.number(),
			startedShare: z.number(),
			medianWaitMs: z.optional(z.number()),
			medianRunMs: z.optional(z.number()),
			p90RunMs: z.optional(z.number()),
			successRate: z.optional(z.number()),
		}),
	),
});
export type JobTimesReport = z.infer<typeof JobTimesReportJson>;

const RunRowJson = z.record(z.string(), z.json());
type RunRow = z.infer<typeof RunRowJson>;

function runKey(run: RunFact): string {
	return `${run.repository}#${run.id}/${run.attempt}`;
}

export type DashboardFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

function parsedJson(text: string): JsonValue | undefined {
	try {
		return z.json().parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export class DashboardReadApi {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly fetcher: DashboardFetch,
	) {}

	private readonly runRows = new Map<string, RunRow>();

	private async get(
		path: string,
		params: ReadonlyMap<string, string | undefined>,
	): Promise<JsonValue> {
		const url = new URL(`${READ_API_PREFIX}${path}`, this.baseUrl);
		for (const [name, value] of params)
			if (value !== undefined) url.searchParams.set(name, value);
		const response = await this.fetcher(url.toString(), {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${this.token}`,
			},
		});
		const body = parsedJson(await response.text());
		if (response.ok && body !== undefined) return body;
		const refused = ErrorJson.safeParse(body);
		if (refused.success)
			throw new DashboardApiError(
				response.status,
				refused.data.code,
				refused.data.error,
				refused.data.command,
			);
		throw new DashboardApiError(
			response.status,
			"unexpected",
			`the read API answered ${response.status}`,
			undefined,
		);
	}

	async runnerOrder(repository: string): Promise<OrderReply> {
		const body = OrderJson.parse(
			await this.get("/runner-order", new Map([["repository", repository]])),
		);
		const problem = body.problem ?? "";
		return {
			repository: body.repository,
			ref: body.ref,
			order:
				problem === ""
					? parseRunnerOrder(JSON.stringify(body.order))
					: DEFAULT_RUNNER_ORDER,
			problem,
		};
	}

	async routes(
		repository: string | undefined,
	): Promise<readonly RunnerRouteEvent[]> {
		const body = PageJson.parse(
			await this.get(
				"/routes",
				new Map([
					["repository", repository],
					["limit", String(DASHBOARD_PAGE_LIMIT)],
				]),
			),
		);
		return (body.routes ?? []).map((row) =>
			parseRunnerRouteEvent(JSON.stringify(row)),
		);
	}

	async machines(): Promise<readonly MachineAdvert[]> {
		const body = PageJson.parse(
			await this.get(
				"/machines",
				new Map([["limit", String(DASHBOARD_PAGE_LIMIT)]]),
			),
		);
		return (body.machines ?? []).map((row) =>
			parseMachineAdvert(JSON.stringify(row)),
		);
	}

	async runs(repository: string | undefined): Promise<readonly RunFact[]> {
		const body = PageJson.parse(
			await this.get(
				"/runs",
				new Map([
					["repository", repository],
					["limit", String(DASHBOARD_PAGE_LIMIT)],
				]),
			),
		);
		return (body.runs ?? []).map((row) => {
			const object = RunRowJson.parse(row);
			const run = parseRunFact(JSON.stringify(object));
			this.runRows.set(runKey(run), object);
			return run;
		});
	}

	async runWithJobs(run: RunFact): Promise<RunFact> {
		const row = this.runRows.get(runKey(run));
		if (row === undefined)
			throw new DashboardApiError(
				404,
				"not-found",
				"run attempt not listed",
				undefined,
			);
		const body = PageJson.parse(
			await this.get(
				`/runs/${run.id}/${run.attempt}/jobs`,
				new Map([
					["repository", run.repository],
					["limit", String(DASHBOARD_PAGE_LIMIT)],
				]),
			),
		);
		return parseRunFact(JSON.stringify({ ...row, jobs: body.jobs ?? [] }));
	}

	async signals(repository: string | undefined): Promise<SignalReport> {
		return SignalReportJson.parse(
			await this.get("/signals", new Map([["repository", repository]])),
		);
	}

	async jobTimes(repository: string | undefined): Promise<JobTimesReport> {
		return JobTimesReportJson.parse(
			await this.get("/job-times", new Map([["repository", repository]])),
		);
	}
}
