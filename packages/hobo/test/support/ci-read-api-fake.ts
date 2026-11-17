/**
 * A relay's read API for the `hobo ci activity`, `usage` and `performance`
 * tests: the frozen `GET /v1/accounts/self/...` paths (ADR-0183) served from
 * the in-memory ports, answering route journal entries as protobuf JSON and
 * the reports as the relay computes them. A host without a journal or run
 * history answers 404 `not-stored-here`, as the stateless host does.
 */
import { toJson } from "@bufbuild/protobuf";
import {
	type InsightStore,
	type MinutesReader,
	type RouteJournal,
	RunnerRouteEventSchema,
} from "@hobo/ci";
import {
	type InsightRun,
	jobTimes,
	runnerTimes,
	workflowTimes,
} from "@hobo/ci/insights";
import { signalBreakdown } from "@hobo/ci/insights/breakdown";
import { type MinuteRate, usageReport } from "@hobo/ci/insights/usage";

export const FAKE_RELAY_ORIGIN = "https://relay.example.test";
export const FAKE_RELAY_TOKEN = "hobo_ci_test_token";
export const FAKE_GITHUB_RATE: MinuteRate = {
	usdPerMinute: 0.006,
	source:
		"https://docs.github.com/en/billing/concepts/product-billing/github-actions",
	readOn: "2026-11-17",
};

const DAY_MS = 86_400_000;
const PREFIX = "/v1/accounts/self";

export type FakeReadApi = Readonly<{
	accountId: string;
	/** Connected repositories; `public` ones save no money. */
	repositories: readonly Readonly<{ name: string; public: boolean }>[];
	journal: RouteJournal | undefined;
	insights: InsightStore | undefined;
	minutes: MinutesReader | undefined;
	nowMs: () => number;
	/** Every path and query asked, in order. */
	asked: string[];
}>;

function json(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json" },
	});
}

function notStored(store: string, command: string): Response {
	return json(
		404,
		JSON.stringify({
			error: `not stored here: this relay keeps no ${store}; read GitHub with \`${command}\``,
			code: "not-stored-here",
			command,
		}),
	);
}

async function storedRuns(
	api: FakeReadApi,
	store: InsightStore,
	repository: string | null,
	sinceMs: number,
): Promise<readonly InsightRun[]> {
	const names =
		repository === null
			? api.repositories.map((entry) => entry.name)
			: [repository];
	const runs: InsightRun[] = [];
	for (const name of names)
		runs.push(
			...(await store.runs({ repository: name, sinceMs, limit: 1000 })),
		);
	return runs.sort((left, right) => right.createdAtMs - left.createdAtMs);
}

/** A `fetch` that answers the read API paths from `api`'s ports. */
export function fakeReadApiFetch(api: FakeReadApi): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		api.asked.push(`${url.pathname}${url.search}`);
		if (url.origin !== FAKE_RELAY_ORIGIN)
			throw new TypeError("fetch failed: no such host");
		if (request.headers.get("authorization") !== `Bearer ${FAKE_RELAY_TOKEN}`)
			return json(
				401,
				JSON.stringify({
					error: "account authentication required",
					code: "unauthenticated",
				}),
			);
		const params = url.searchParams;
		const repository = params.get("repository");
		if (
			repository !== null &&
			!api.repositories.some(
				(entry) => entry.name.toLowerCase() === repository.toLowerCase(),
			)
		)
			return json(
				404,
				JSON.stringify({
					error: "repository not connected to this account",
					code: "not-found",
				}),
			);
		const since = params.get("since");
		const nowMs = api.nowMs();
		const path = url.pathname.slice(PREFIX.length);
		if (path === "/routes") {
			if (!api.journal) return notStored("route journal", "hobo ci route");
			const limit = Number(params.get("limit") ?? 50);
			const offset = Number(params.get("cursor") ?? 0);
			const events = await api.journal.decisions({
				accountId: api.accountId,
				repository: repository ?? undefined,
				sinceMs: since === null ? nowMs - 90 * DAY_MS : Number(since),
				limit: offset + limit + 1,
			});
			const rows = events.slice(offset, offset + limit);
			return json(
				200,
				JSON.stringify({
					routes: rows.map((event) => toJson(RunnerRouteEventSchema, event)),
					...(events.length > offset + limit
						? { next: String(offset + limit) }
						: undefined),
				}),
			);
		}
		if (path === "/usage" || path === "/job-times" || path === "/signals") {
			const command =
				path === "/signals"
					? "hobo ci signals"
					: path === "/usage"
						? "hobo ci usage --source github"
						: "hobo ci performance --source github";
			if (!api.insights) return notStored("run history", command);
			const sinceMs = since === null ? nowMs - 30 * DAY_MS : Number(since);
			const runs = await storedRuns(api, api.insights, repository, sinceMs);
			const head = { sinceMs, runs: runs.length };
			if (path === "/signals") {
				const breakdown = signalBreakdown(runs);
				return json(
					200,
					JSON.stringify({
						...head,
						signals: breakdown.signals,
						by: breakdown.by,
						trend: breakdown.trend,
					}),
				);
			}
			if (path === "/job-times")
				return json(
					200,
					JSON.stringify({
						...head,
						workflows: workflowTimes(runs),
						jobs: jobTimes(runs),
						runners: runnerTimes(runs, { nowMs }),
					}),
				);
			const owners = new Set(
				api.repositories.map((entry) => entry.name.split("/")[0] ?? ""),
			);
			const owner = owners.size === 1 ? [...owners][0] : undefined;
			const included =
				owner === undefined ? undefined : await api.minutes?.usage(owner);
			return json(
				200,
				JSON.stringify({
					...head,
					...usageReport(runs, {
						githubRate: FAKE_GITHUB_RATE,
						included,
						publicRepositories: new Set(
							api.repositories
								.filter((entry) => entry.public)
								.map((entry) => entry.name),
						),
					}),
				}),
			);
		}
		return json(
			404,
			JSON.stringify({ error: "no such path", code: "not-found" }),
		);
	};
}
