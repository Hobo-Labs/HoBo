/**
 * The generated parts of the HoBo CI pages on the docs site.
 *
 * The site demonstrates the fleet by showing what it actually decides, so the
 * tables and worked examples on those pages are not typed by hand: they are
 * rendered here from the financial models and by running `balanceFleet`, and
 * written between `<!-- generated:… -->` markers in the page source.
 * `test/fleet-docs.test.ts` fails when a page no longer matches this output.
 *
 *   node --import tsx packages/ci/scripts/fleet-docs.ts          # rewrite
 *   node --import tsx packages/ci/scripts/fleet-docs.ts --check  # verify
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BudgetPolicy, parseBudgetPolicy } from "@hobo/core";
import { isQuoteVector, QuoteEngine } from "@hobo/pricing";
import {
	balanceFleet,
	type FleetBalance,
	type FleetBalanceInput,
	type FleetDemand,
	type FleetMemberState,
	fleetRoutesVariableValue,
	fleetRouteTable,
	RUNNER_FINANCIAL_MODELS,
	type RunnerFinancialModel,
	type RunnerModelId,
	runnerQuoteScenario,
} from "../src/fleet/index.js";

/** Every example is priced at this instant, inside the models' evidence. */
const AT = "2026-11-10T00:00:00Z";
const BOX_SLOTS = 3;

const PAGES = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../site/src/pages/ci",
);

function policy(limitMicros: number): BudgetPolicy {
	return parseBudgetPolicy({
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "acme",
		budgetId: "ci",
		periodId: "2026-11",
		revision: "docs-001",
		workloads: ["ci"],
		currency: "USD",
		limitMicros,
		objective: "min-cost",
		enforcement: "conservative",
		periodKind: "manual",
		constraints: [],
	});
}

/** The whole catalog as one fleet: connected, healthy, plans already open. */
function fleet(
	overrides: Partial<Record<RunnerModelId, Partial<FleetMemberState>>> = {},
): FleetMemberState[] {
	return RUNNER_FINANCIAL_MODELS.map((model) => {
		const isBox = model.id === "hobo-box";
		const member: FleetMemberState = {
			model,
			enabled: true,
			activeJobs: 0,
			healthy: true,
			commercial: { subscribed: true },
			payer: model.provider,
			payerExposureMicros: 0,
			servesLabels: isBox ? ["hobo-trunk"] : [],
		};
		const sized = isBox ? { ...member, concurrency: BOX_SLOTS } : member;
		return { ...sized, ...overrides[model.id] };
	});
}

const BOX_FULL = { "hobo-box": { activeJobs: BOX_SLOTS } } as const;

const PULL_REQUEST: FleetDemand = {
	id: "acme/app:1001:1:1",
	minutes: 20,
	repository: { visibility: "public", ownerType: "organization" },
	forkPullRequest: false,
	needsDocker: true,
	isolationRequired: true,
};

function decide(
	members: readonly FleetMemberState[],
	demand: FleetDemand,
	overrides: Partial<FleetBalanceInput> = {},
): FleetBalance {
	return balanceFleet({
		members,
		demand,
		policy: policy(50_000_000),
		exposureMicros: 0,
		activeWork: 0,
		now: AT,
		allowNewProviderAgreements: false,
		...overrides,
	});
}

// ------------------------------------------------------------ formatting

const NAMES = new Map<string, string>(
	RUNNER_FINANCIAL_MODELS.map((model) => [model.id, model.displayName]),
);

function usd(micros: number): string {
	if (micros === 0) return "$0";
	return `$${(micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function table(header: readonly string[], rows: readonly string[][]): string {
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

function decision(result: FleetBalance): string {
	const ranking =
		result.ranking.length === 0
			? "No member is admitted. The job waits on the label it has."
			: table(
					["Rank", "Member", "Tier", "Job asks for", "Adds to the bill"],
					result.ranking.map((choice, index) => [
						String(index + 1),
						NAMES.get(choice.memberId) ?? choice.memberId,
						choice.role,
						`\`${choice.runsOn}\``,
						choice.usesAllowance
							? `${usd(choice.incrementalBilledMicros)} (included minutes)`
							: usd(choice.incrementalBilledMicros),
					]),
				);
	const refusals = table(
		["Not chosen", "Code", "Why"],
		result.refusals.map((refusal) => [
			NAMES.get(refusal.memberId) ?? refusal.memberId,
			`\`${refusal.code}\``,
			refusal.reason,
		]),
	);
	return result.refusals.length === 0 ? ranking : `${ranking}\n\n${refusals}`;
}

// -------------------------------------------------------------- fragments

/** A provider can be named in policy today when the relay can reach it. */
function policyStatus(model: RunnerFinancialModel): string {
	if (model.provider === "hobo-box-worker") return "yes";
	if (model.binding === "inject") return "modelled only (no host driver)";
	if (model.provider === "jog" || model.provider === "boat")
		return "yes, through the bridge";
	return "yes";
}

function providers(): string {
	return table(
		[
			"Provider",
			"Reaches a job by",
			"USD per minute",
			"Included each month",
			"Plan fee",
			"Jobs at once",
			"Usable in policy today",
		],
		RUNNER_FINANCIAL_MODELS.map((model) => [
			model.displayName,
			model.binding,
			model.evidence.derived
				? `${model.usdPerMinute} (derived)`
				: model.usdPerMinute,
			model.monthlyFreeMinutes ? `${model.monthlyFreeMinutes} min` : "—",
			model.monthlyFeeUsd ? `$${model.monthlyFeeUsd}` : "—",
			model.concurrency === undefined
				? "set in policy"
				: String(model.concurrency),
			policyStatus(model),
		]),
	);
}

function eligibility(): string {
	return table(
		[
			"Provider",
			"Public repos",
			"Private repos",
			"Orgs only",
			"Docker",
			"Fork PRs",
			"Own machine",
		],
		RUNNER_FINANCIAL_MODELS.map((model) => [
			model.displayName,
			model.eligibility.publicRepositories,
			yesNo(model.eligibility.privateRepositories),
			yesNo(model.eligibility.organizationOnly),
			yesNo(model.eligibility.docker),
			yesNo(model.eligibility.forkPullRequests),
			yesNo(model.eligibility.isolated),
		]),
	);
}

function sources(): string {
	return RUNNER_FINANCIAL_MODELS.map(
		(model) =>
			`- **${model.displayName}** — read ${model.evidence.observedAt.slice(0, 10)} from <${model.evidence.source}>. ${model.evidence.note}`,
	).join("\n");
}

function billed(
	model: RunnerFinancialModel,
	minutes: number,
	state: { subscribed: boolean; allowanceRemainingMinutes?: string },
): string {
	const result = QuoteEngine.quote(
		runnerQuoteScenario({ model, state, tenantId: "acme", minutes, at: AT }),
	);
	if (!isQuoteVector(result)) throw new Error(`${model.id}: ${result.code}`);
	return `$${result.incremental?.billed?.decimal ?? "?"}`;
}

function pricing(): string {
	return table(
		[
			"Provider",
			"20-minute job",
			"Same job after the included minutes are gone",
			"Same job if it opens the plan",
		],
		RUNNER_FINANCIAL_MODELS.map((model) => [
			model.displayName,
			billed(model, 20, { subscribed: true }),
			model.monthlyFreeMinutes
				? billed(model, 20, {
						subscribed: true,
						allowanceRemainingMinutes: "0",
					})
				: "—",
			model.monthlyFeeUsd ? billed(model, 20, { subscribed: false }) : "—",
		]),
	);
}

function routes(members: readonly FleetMemberState[]): string {
	const demand = {
		minutes: PULL_REQUEST.minutes,
		repository: PULL_REQUEST.repository,
		needsDocker: true,
	};
	const routed = fleetRouteTable({
		members,
		classes: [
			{
				name: "pr",
				hoboLabel: "hobo",
				demand: { ...demand, forkPullRequest: false, isolationRequired: true },
			},
			{
				name: "fork",
				hoboLabel: "hobo",
				demand: { ...demand, forkPullRequest: true, isolationRequired: true },
			},
			{
				name: "trunk",
				hoboLabel: "hobo-trunk",
				demand: { ...demand, forkPullRequest: false, isolationRequired: true },
			},
		],
		policy: policy(50_000_000),
		exposureMicros: 0,
		activeWork: 0,
		now: AT,
		allowNewProviderAgreements: false,
	});
	return `\`\`\`json\n${fleetRoutesVariableValue(routed)}\n\`\`\``;
}

/** Fragment id to markdown, grouped by the page that holds it. */
export function renderFleetDocs() {
	const privateTrunk: FleetDemand = {
		...PULL_REQUEST,
		id: "acme/app:1002:1:1",
		repository: { visibility: "private", ownerType: "organization" },
		isolationRequired: false,
	};
	return {
		"providers.md": {
			providers: providers(),
			eligibility: eligibility(),
			pricing: pricing(),
			sources: sources(),
		},
		"fleet-balancing.md": {
			"box-free": decision(decide(fleet(), PULL_REQUEST)),
			"box-full": decision(decide(fleet(BOX_FULL), PULL_REQUEST)),
			"private-trunk": decision(decide(fleet(BOX_FULL), privateTrunk)),
			queued: decision(
				decide(fleet(BOX_FULL), { ...PULL_REQUEST, queuedOnLabel: "hobo" }),
			),
			"budget-spent": decision(
				decide(fleet(BOX_FULL), PULL_REQUEST, {
					policy: policy(5_000_000),
					exposureMicros: 5_000_000,
				}),
			),
			"box-unhealthy": decision(
				decide(fleet({ "hobo-box": { healthy: false } }), PULL_REQUEST),
			),
		},
		"route-table.md": {
			"routes-box-free": routes(fleet()),
			"routes-box-full": routes(fleet(BOX_FULL)),
		},
	};
}

const marker = (id: string, edge: "start" | "end") =>
	`<!-- generated:${id}:${edge} -->`;

/** The page with every generated fragment replaced by its current output. */
export function applyFleetDocs(
	page: string,
	fragments: Readonly<Record<string, string>>,
): string {
	let next = page;
	for (const [id, body] of Object.entries(fragments)) {
		const start = next.indexOf(marker(id, "start"));
		const end = next.indexOf(marker(id, "end"));
		if (start < 0 || end < start)
			throw new Error(`page has no generated:${id} markers`);
		next = `${next.slice(0, start)}${marker(id, "start")}\n\n${body}\n\n${next.slice(end)}`;
	}
	return next;
}

export function fleetDocsPages(): {
	path: string;
	current: string;
	next: string;
}[] {
	return Object.entries(renderFleetDocs()).map(([file, fragments]) => {
		const path = join(PAGES, file);
		const current = readFileSync(path, "utf8");
		return { path, current, next: applyFleetDocs(current, fragments) };
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes("--check");
	const stale = fleetDocsPages().filter((page) => page.current !== page.next);
	for (const page of stale) {
		if (check) console.error(`stale generated section: ${page.path}`);
		else writeFileSync(page.path, page.next);
	}
	if (check && stale.length > 0) process.exit(1);
}
