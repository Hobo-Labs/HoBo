/**
 * What each view reads from the read API, and the view's markup. The browser
 * client calls `loadView` on every navigation; the gauntlet steps call it the
 * same way against a relay's read API, with no browser.
 */
import type { MachineAdvert, RunFact, RunnerRouteEvent } from "@hobo/ci";
import type { DashboardLocation } from "./location.js";
import type { DashboardReadApi, OrderReply } from "./read-api.js";
import {
	renderHistory,
	renderPerformance,
	renderRouter,
	renderRunners,
	renderSignals,
} from "./views.js";
import { questionFromRoutes, type WhatIfQuestion, whatIf } from "./what-if.js";

/** What the Router view loaded, kept so the what-if panel can walk again without reading anything. */
export type RouterState = Readonly<{
	order: OrderReply;
	routes: readonly RunnerRouteEvent[];
	machines: readonly MachineAdvert[];
	question: WhatIfQuestion;
}>;

export type LoadedView = Readonly<{
	html: string;
	/** Repositories seen in what was read, for the repository picker. */
	repositories: readonly string[];
	/** Set on the Router view. */
	router: RouterState | undefined;
}>;

function seen(
	routes: readonly RunnerRouteEvent[],
	runs: readonly RunFact[],
): readonly string[] {
	const names = new Set<string>();
	for (const event of routes)
		if (event.request?.repository) names.add(event.request.repository);
	for (const run of runs) names.add(run.repository);
	return [...names].sort();
}

/** The Router view again, with the what-if walked for `question`. Reads nothing. */
export function routerWithAnswer(
	state: RouterState,
	question: WhatIfQuestion,
	nowMs: number,
): string {
	return renderRouter({
		nowMs,
		order: state.order,
		routes: state.routes,
		question,
		answer:
			state.order.problem === ""
				? whatIf(state.order.order, question, state.machines, nowMs)
				: undefined,
	});
}

/** Read what `location` needs and render it. Throws `DashboardApiError` when the relay refuses. */
export async function loadView(
	api: DashboardReadApi,
	location: DashboardLocation,
	nowMs: number,
): Promise<LoadedView> {
	const { repository } = location;
	switch (location.view) {
		case "runners": {
			const [machines, routes] = await Promise.all([
				api.machines(),
				api.routes(undefined),
			]);
			return {
				html: renderRunners({ nowMs, machines, routes }),
				repositories: seen(routes, []),
				router: undefined,
			};
		}
		case "router": {
			const routes = await api.routes(repository);
			const name =
				repository ??
				routes.find((event) => event.request)?.request?.repository;
			if (name === undefined)
				return {
					html: `<section aria-labelledby="order-heading"><h2 id="order-heading">Runner order</h2><p class="empty">No route decision is journaled yet, so no repository is known. Pick one with <code>?repository=owner/name</code>.</p></section>`,
					repositories: [],
					router: undefined,
				};
			const [order, machines] = await Promise.all([
				api.runnerOrder(name),
				api.machines(),
			]);
			const question = questionFromRoutes(name, order.order, routes);
			const router: RouterState = { order, routes, machines, question };
			return {
				html: renderRouter({
					nowMs,
					order,
					routes,
					question,
					answer: undefined,
				}),
				repositories: seen(routes, []),
				router,
			};
		}
		case "history": {
			const runs = await api.runs(repository);
			const wanted = location.run;
			const listed =
				wanted === undefined
					? undefined
					: runs.find(
							(run) =>
								run.id === wanted.id &&
								run.attempt === wanted.attempt &&
								run.repository.toLowerCase() ===
									wanted.repository.toLowerCase(),
						);
			const selected =
				listed === undefined ? undefined : await api.runWithJobs(listed);
			return {
				html: renderHistory({ nowMs, runs, selected }),
				repositories: seen([], runs),
				router: undefined,
			};
		}
		case "performance":
			return {
				html: renderPerformance(await api.jobTimes(repository)),
				repositories: [],
				router: undefined,
			};
		case "signals":
			return {
				html: renderSignals(await api.signals(repository)),
				repositories: [],
				router: undefined,
			};
	}
}
