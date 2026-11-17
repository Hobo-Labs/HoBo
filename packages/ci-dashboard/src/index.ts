/**
 * `@hobo/ci-dashboard`: the HoBo CI relay's read-only dashboard (ADR-0183).
 *
 * A relay mounts `createDashboardRoute()` beside its read API; the page reads
 * that API from the browser. The views and the what-if walk are exported so
 * they can be rendered and tested without a browser.
 */

export {
	type LoadedView,
	loadView,
	type RouterState,
	routerWithAnswer,
} from "./load.js";
export {
	type DashboardLocation,
	parseDashboardLocation,
	parseRepository,
} from "./location.js";
export {
	type DashboardPageOptions,
	dashboardCsp,
	dashboardCss,
	renderDashboardPage,
	THEME_BOOT_SCRIPT,
} from "./page.js";
export {
	DASHBOARD_PAGE_LIMIT,
	DashboardApiError,
	type DashboardFetch,
	DashboardReadApi,
	type JobTimesReport,
	type OrderReply,
	READ_API_PREFIX,
	type SignalReport,
} from "./read-api.js";
export {
	createDashboardRoute,
	DASHBOARD_BASE_PATH,
	type DashboardRouteOptions,
	readDashboardScript,
} from "./route.js";
export {
	DASHBOARD_FORBIDDEN_HEX,
	DASHBOARD_TOKEN_VALUES,
	DASHBOARD_TOKENS,
} from "./tokens.js";
export {
	ADOPTED_RUNNER_SIGNER,
	type Attention,
	DASHBOARD_VIEWS,
	type DashboardView,
	editOrderUrl,
	type FleetSummary,
	fleetSummary,
	type HistoryModel,
	type LampState,
	machineAttention,
	PROJECT_CONFIG_PATH,
	type RouterModel,
	type RunnersModel,
	renderHistory,
	renderPerformance,
	renderRouter,
	renderRunners,
	renderSignals,
	runDiagnoses,
	runHash,
	SIGNAL_TITLES,
	type StepHealth,
	stepHealth,
	VIEW_TITLES,
} from "./views.js";
export {
	blankQuestion,
	isHostedStep,
	MACHINE_ONLINE_WINDOW_MS,
	machineIsOnline,
	questionFromRoutes,
	type WhatIfQuestion,
	whatIf,
} from "./what-if.js";
