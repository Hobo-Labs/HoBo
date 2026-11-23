import {
	ANY_MACHINE_LABEL,
	FLEET_LABEL,
	type FleetState,
	HOSTED_RUNNER_PROVIDERS,
	isProviderLabel,
	isUnresolvedAuto,
	type MachineCandidate,
	NO_ROUTE_FACTS,
	newProviderHealth,
	PROVIDER_HEALTH_DEFAULTS,
	type ProviderOutcome,
	providerHealthKey,
	providerHealthState,
	type RouteFacts,
	type RouteFactsSource,
	type RunnerRouteRequest,
	type RunnerStepKey,
	recordProviderOutcome,
	relayInputs,
} from "@hobo/ci";

import { z } from "zod";
import { DEFAULT_RUNNER_ROUTING } from "../isolated-worker/box-routing-policy.js";
import {
	judgeRoutingSlip,
	type ParsedRoutingSlip,
	ROUTING_SLIP_REF,
	type RoutingSlipClassName,
} from "../routing-slip.js";
import { runnerRoutingLabels } from "../runner-routing.js";
import {
	DEFAULT_QUEUE_LIMITS,
	type QueueJob,
	type QueueLimits,
	queueEvidence,
	queueJobsOf,
	queueRunsOf,
	refusingJobs,
	runsJustAhead,
	runsToRead,
	takingJobs,
} from "./queue-evidence.js";

export const GITHUB_FACTS_MAX_CALLS = 12;
export const GITHUB_FACTS_BUDGET_MS = 10_000;
// public-contract: the title of the warning a relay job prints when its facts could not be read.
export const GITHUB_FACTS_WARNING_TITLE = "hobo-ci-relay-facts";
// public-contract: GitHub's REST API root when none is given.
export const GITHUB_API_URL = "https://api.github.com";

export type GithubRouteFactsWarning = Readonly<{
	title: string;
	message: string;
}>;

export type GithubRouteFactsOptions = Readonly<{
	token: string;
	apiUrl?: string | undefined;
	fetch?: typeof fetch | undefined;
	slipLabels?: ReadonlySet<string> | undefined;
	limits?: QueueLimits | undefined;
	budgetMs?: number | undefined;
}>;

export type GithubQueueRead = Readonly<{
	slip: ParsedRoutingSlip | undefined;
	jobs: readonly QueueJob[];
	undecidedAhead: number;
}>;

const TRUNK_EVENTS: ReadonlySet<string> = new Set([
	"push",
	"workflow_dispatch",
	"merge_group",
	"workflow_run",
]);

function routeClassOf(request: RunnerRouteRequest): RoutingSlipClassName {
	if (TRUNK_EVENTS.has(request.event)) return "trunk";
	return request.fork ? "fork" : "pr";
}

function namedLabels(
	request: RunnerRouteRequest,
	key: Extract<RunnerStepKey, "fleet" | "machine">,
): readonly string[] {
	const inputs = relayInputs(request.inputs);
	const auto = key === "fleet" ? FLEET_LABEL : ANY_MACHINE_LABEL;
	if (inputs.size === 0) return [auto];
	const labels = inputs.get(key) ?? [];
	return isUnresolvedAuto(labels) ? [auto] : labels;
}

function fleetFacts(
	read: GithubQueueRead,
	request: RunnerRouteRequest,
	nowMs: number,
	limits: QueueLimits,
): FleetState {
	const label = namedLabels(request, "fleet")[0] ?? FLEET_LABEL;
	const evidence = queueEvidence(read.jobs, label, nowMs);
	const { slip } = read;
	const classRoute = slip?.classes[routeClassOf(request)];
	const route =
		classRoute?.tier === "fleet" &&
		classRoute.runner.toLowerCase() === label.toLowerCase()
			? classRoute
			: undefined;
	const slipOpen = route !== undefined && route.reason !== "fleet-busy";
	const slipBusy = route !== undefined && route.reason === "fleet-busy";
	const taking = slipBusy
		? takingJobs(evidence, { ...limits, maxQueued: Number.MAX_SAFE_INTEGER })
		: read.undecidedAhead === 0 &&
			(slipOpen
				? !refusingJobs(evidence, limits)
				: takingJobs(evidence, limits));
	return {
		enabled: route !== undefined || evidence.recentPickups > 0,
		taking,
		isolated: slip?.classes.fork.tier === "fleet",
	};
}

function machineFacts(
	read: GithubQueueRead,
	request: RunnerRouteRequest,
	nowMs: number,
): readonly MachineCandidate[] {
	const labels = namedLabels(request, "machine");
	const seen = new Set<string>();
	return labels.flatMap((label): MachineCandidate[] => {
		const lower = label.toLowerCase();
		if (seen.has(lower)) return [];
		seen.add(lower);
		const evidence = queueEvidence(read.jobs, label, nowMs);
		const full = evidence.waiting > 0 || read.undecidedAhead > 0;
		return [
			{
				id: label,
				name: label,
				runsOn: label,
				labels,
				online: evidence.recentPickups > 0,
				paused: false,
				slots: 1,
				busy: full ? 1 : 0,
				sharing: "anyone",
				ownerId: "",
				ownerCanRead: true,
				lastPickedAtMs: evidence.lastPickupAtMs,
				repository: undefined,
			},
		];
	});
}

function unhealthyFacts(
	jobs: readonly QueueJob[],
	nowMs: number,
): ReadonlySet<string> {
	const outcomes = new Map<string, ProviderOutcome[]>();
	for (const job of jobs) {
		const label = job.labels.length === 1 ? job.labels[0] : undefined;
		const provider =
			label &&
			HOSTED_RUNNER_PROVIDERS.find((key) => isProviderLabel(key, label));
		if (!label || !provider) continue;
		const missAtMs = job.createdAtMs + PROVIDER_HEALTH_DEFAULTS.missedAfterMs;
		const outcome: ProviderOutcome | undefined =
			job.startedAtMs !== undefined
				? { atMs: job.startedAtMs, started: true }
				: missAtMs <= nowMs
					? { atMs: missAtMs, started: false }
					: undefined;
		if (!outcome) continue;
		const key = providerHealthKey(provider, label);
		outcomes.set(key, [...(outcomes.get(key) ?? []), outcome]);
	}
	const unhealthy = new Set<string>();
	for (const [key, seen] of outcomes) {
		const health = [...seen]
			.sort((left, right) => left.atMs - right.atMs)
			.reduce(
				(record, outcome) => recordProviderOutcome(record, outcome),
				newProviderHealth(),
			);
		if (providerHealthState(health, nowMs) === "unhealthy") unhealthy.add(key);
	}
	return unhealthy;
}

export function routeFactsFromQueue(
	read: GithubQueueRead,
	request: RunnerRouteRequest,
	nowMs: number,
	limits: QueueLimits = DEFAULT_QUEUE_LIMITS,
): RouteFacts {
	return {
		fleet: fleetFacts(read, request, nowMs, limits),
		machines: machineFacts(read, request, nowMs),
		minutes: undefined,
		spendUsd: new Map(),
		unhealthy: unhealthyFacts(read.jobs, nowMs),
		publicOptIn: new Set(),
		first: undefined,
		retry: undefined,
	};
}

class FactsReadFailure extends Error {
	override readonly name = "FactsReadFailure";
}

const RefBody = z.object({
	object: z.object({
		sha: z.string().regex(/^[0-9a-f]{40}$/u),
		type: z.string(),
	}),
});
const CommitBody = z.object({ message: z.string() });

type JsonInput = z.infer<ReturnType<typeof z.json>>;

export class GithubRouteFacts implements RouteFactsSource {
	readonly warnings: GithubRouteFactsWarning[] = [];
	private readonly apiUrl: string;
	private readonly get: typeof fetch;
	private readonly slipLabels: ReadonlySet<string>;
	private readonly limits: QueueLimits;
	private readonly budgetMs: number;

	constructor(private readonly options: GithubRouteFactsOptions) {
		this.apiUrl = (options.apiUrl ?? GITHUB_API_URL).replace(/\/+$/u, "");
		this.get = options.fetch ?? fetch;
		this.slipLabels =
			options.slipLabels ?? runnerRoutingLabels(DEFAULT_RUNNER_ROUTING);
		this.limits = options.limits ?? DEFAULT_QUEUE_LIMITS;
		this.budgetMs = options.budgetMs ?? GITHUB_FACTS_BUDGET_MS;
	}

	async facts(request: RunnerRouteRequest, nowMs: number): Promise<RouteFacts> {
		try {
			const read = await this.read(request, nowMs);
			return routeFactsFromQueue(read, request, nowMs, this.limits);
		} catch (error) {
			const why =
				error instanceof FactsReadFailure
					? error.message
					: error instanceof Error && error.name === "TimeoutError"
						? `GitHub did not answer in time (${this.budgetMs} ms for every read)`
						: `GitHub could not be read (${error instanceof Error ? error.message : String(error)})`;
			this.warnings.push({
				title: GITHUB_FACTS_WARNING_TITLE,
				message: `The runner facts were not read: ${why}. The runner order was walked with nothing measured.`,
			});
			return { ...NO_ROUTE_FACTS };
		}
	}

	private async read(
		request: RunnerRouteRequest,
		nowMs: number,
	): Promise<GithubQueueRead> {
		const signal = AbortSignal.timeout(this.budgetMs);
		let calls = 0;
		const repo = `/repos/${request.repository}`;
		const ask = async (
			path: string,
			allowMissing = false,
		): Promise<JsonInput | undefined> => {
			calls += 1;
			const response = await this.get(`${this.apiUrl}${repo}${path}`, {
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${this.options.token}`,
					"x-github-api-version": "2022-11-28",
					"user-agent": "hobo-ci-relay",
				},
				signal,
			});
			if (allowMissing && response.status === 404) return undefined;
			if (response.status !== 200)
				throw new FactsReadFailure(
					`GitHub answered HTTP ${response.status} for ${path.split("?")[0]}`,
				);
			const text = await response.text();
			try {
				return JSON.parse(text);
			} catch {
				throw new FactsReadFailure(`GitHub's answer for ${path} is not JSON`);
			}
		};
		const slip = await this.readSlip(request, nowMs, ask);
		const runs = queueRunsOf((await ask("/actions/runs?per_page=100")) ?? null);
		if (!runs) throw new FactsReadFailure("the run list is not one");
		const ownRunId = Number(request.runId);
		const ahead = new Set(runsJustAhead(runs, ownRunId, nowMs));
		const jobs: QueueJob[] = [];
		let undecidedAhead = ahead.size;
		const toRead = runsToRead(
			runs,
			ownRunId,
			nowMs,
			GITHUB_FACTS_MAX_CALLS - calls,
		);
		for (const runId of toRead) {
			const page = queueJobsOf(
				(await ask(`/actions/runs/${runId}/jobs?filter=latest&per_page=100`)) ??
					null,
			);
			if (!page)
				throw new FactsReadFailure(`run ${runId}'s job list is not one`);
			jobs.push(...page.jobs);
			if (ahead.has(runId) && page.chosen) undecidedAhead -= 1;
		}
		return { slip, jobs, undecidedAhead };
	}

	private async readSlip(
		request: RunnerRouteRequest,
		nowMs: number,
		ask: (
			path: string,
			allowMissing?: boolean,
		) => Promise<JsonInput | undefined>,
	): Promise<ParsedRoutingSlip | undefined> {
		const ref = ROUTING_SLIP_REF.replace(/^refs\//u, "");
		const refBody = RefBody.safeParse(await ask(`/git/ref/${ref}`, true));
		if (!refBody.success || refBody.data.object.type !== "commit")
			return undefined;
		const commit = CommitBody.safeParse(
			await ask(`/git/commits/${refBody.data.object.sha}`, true),
		);
		if (!commit.success) return undefined;
		const judged = judgeRoutingSlip(commit.data.message, {
			repository: request.repository,
			nowMs,
			labels: this.slipLabels,
		});
		return judged.ok ? judged.slip : undefined;
	}
}
