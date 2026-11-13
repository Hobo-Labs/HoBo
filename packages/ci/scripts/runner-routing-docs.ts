/**
 * The generated parts of the HoBo CI pages on the docs site.
 *
 * The site demonstrates runner routing by showing what it actually decides, so the
 * tables and worked examples on those pages are not typed by hand: they are
 * rendered here from the financial models and by running `balanceRunnerProviders`, and
 * written between `<!-- generated:… -->` markers in the page source.
 * `test/runner-routing-docs.test.ts` fails when a page no longer matches this output.
 *
 *   node --import tsx packages/ci/scripts/runner-routing-docs.ts          # rewrite
 *   node --import tsx packages/ci/scripts/runner-routing-docs.ts --check  # verify
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BudgetPolicy, parseBudgetPolicy } from "@hobo/core";
import { isQuoteVector, QuoteEngine } from "@hobo/pricing";
import {
	balanceRunnerProviders,
	RUNNER_FINANCIAL_MODELS,
	RUNNER_REFUSAL_CODES,
	type RunnerBalance,
	type RunnerBalanceInput,
	type RunnerDemand,
	type RunnerFinancialModel,
	type RunnerModelId,
	type RunnerProviderState,
	runnerQuoteScenario,
} from "../src/runner-routing/index.js";

/**
 * Every example is priced the day after the newest price was read, so the
 * instant is inside every model's evidence and moves with it when a price is
 * refreshed.
 */
const AT = new Date(
	Math.max(
		...RUNNER_FINANCIAL_MODELS.map((model) =>
			Date.parse(model.evidence.observedAt),
		),
	) + 86_400_000,
)
	.toISOString()
	.replace(".000Z", "Z");
const BOX_SLOTS = 3;

const PAGES = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../site/src/pages",
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

/** The whole catalog as one set of providers: connected, healthy, plans already open. */
function catalog(
	overrides: Partial<Record<RunnerModelId, Partial<RunnerProviderState>>> = {},
): RunnerProviderState[] {
	return RUNNER_FINANCIAL_MODELS.map((model) => {
		const isBox = model.id === "hobo-box";
		const member: RunnerProviderState = {
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

const PULL_REQUEST: RunnerDemand = {
	id: "acme/app:1001:1:1",
	minutes: 20,
	repository: { visibility: "public", ownerType: "organization" },
	forkPullRequest: false,
	needsDocker: true,
	isolationRequired: true,
};

function decide(
	members: readonly RunnerProviderState[],
	demand: RunnerDemand,
	overrides: Partial<RunnerBalanceInput> = {},
): RunnerBalance {
	return balanceRunnerProviders({
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

function decision(result: RunnerBalance): string {
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

/**
 * How a relay can use the provider today. Admission reaches every label
 * provider through the companion-workflow bridge, which serves trusted private
 * repositories only; choosing one directly needs a workflow to read the route
 * table, which none does yet.
 */
function policyStatus(model: RunnerFinancialModel): string {
	if (model.provider === "hobo-box-worker") return "yes";
	if (model.binding === "inject") return "no: modelled only, no host driver";
	if (model.provider === "local") return "yes, on a local relay";
	return "yes, through the bridge";
}

/** Where a ceiling the provider does not publish comes from instead. */
function ceiling(model: RunnerFinancialModel): string {
	if (model.concurrency !== undefined) return String(model.concurrency);
	if (model.id === "hobo-box") return "the worker's slots";
	if (model.id === "arc-remote") return "the scale set's size";
	return "no published limit";
}

function providers(): string {
	return table(
		[
			"Provider",
			"Machine",
			"Reaches a job by",
			"USD per minute",
			"Included each month",
			"Plan fee",
			"Jobs at once",
			"Usable today",
		],
		RUNNER_FINANCIAL_MODELS.map((model) => [
			model.displayName,
			`${model.machine.vcpus} vCPU, ${model.machine.memoryGb} GB`,
			model.binding,
			model.evidence.derived
				? `${model.usdPerMinute} (derived)`
				: model.usdPerMinute,
			model.monthlyFreeMinutes ? `${model.monthlyFreeMinutes} min` : "—",
			model.monthlyFeeUsd ? `$${model.monthlyFeeUsd}` : "—",
			ceiling(model),
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

const ISOLATION_WORDS = {
	vm: "own kernel (VM)",
	"sandboxed-container": "container on a user-space kernel",
	container: "container on a shared kernel",
} as const;

function duration(minutes: number | undefined): string {
	if (minutes === undefined) return "no published limit";
	if (minutes < 120 || minutes % 60 !== 0) return `${minutes} min`;
	const hours = minutes / 60;
	return hours % 24 === 0 && hours > 24 ? `${hours / 24} days` : `${hours} h`;
}

/** What each machine can do, for every model whose limits have been read. */
function capabilities(): string {
	return table(
		[
			"Provider",
			"Kept apart by",
			"Longest run",
			"Largest machine",
			"CPU",
			"Own image",
			"Internet out",
			"Egress allow list",
			"Self-hostable",
		],
		RUNNER_FINANCIAL_MODELS.flatMap((model: RunnerFinancialModel) => {
			const limits = model.capabilities;
			if (!limits) return [];
			return [
				[
					`[${model.displayName}](${limits.source})`,
					ISOLATION_WORDS[limits.isolation],
					duration(limits.maxRuntimeMinutes),
					limits.maxMachine
						? `${limits.maxMachine.vcpus} vCPU, ${limits.maxMachine.memoryGb} GB`
						: "not published",
					limits.architectures?.join(", ") ?? "not published",
					yesNo(limits.customImage),
					yesNo(limits.outboundInternet),
					yesNo(limits.egressControl),
					yesNo(limits.selfHostable),
				],
			];
		}),
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

/**
 * The label each class of job would ask for: the selected provider's label
 * when it is a label provider, otherwise the class's own hobo label, where a
 * waiting job can still be reached by injected capacity. Keys are sorted.
 */
function routes(members: readonly RunnerProviderState[]): string {
	const demand = {
		minutes: PULL_REQUEST.minutes,
		repository: PULL_REQUEST.repository,
		needsDocker: true,
		isolationRequired: true,
	};
	const classes = [
		{ name: "fork", hoboLabel: "hobo", forkPullRequest: true },
		{ name: "pr", hoboLabel: "hobo", forkPullRequest: false },
		{ name: "trunk", hoboLabel: "hobo-trunk", forkPullRequest: false },
	] as const;
	const routed = Object.fromEntries(
		classes.map((routeClass) => {
			const { selected } = decide(members, {
				...demand,
				id: `runner-route:${routeClass.name}`,
				forkPullRequest: routeClass.forkPullRequest,
			});
			return [
				routeClass.name,
				selected?.binding === "label" ? selected.runsOn : routeClass.hoboLabel,
			];
		}),
	);
	return `\`\`\`json\n${JSON.stringify(routed)}\n\`\`\``;
}

/** Fragment id to markdown, grouped by the page that holds it. */
export function renderRunnerRoutingDocs() {
	const privateTrunk: RunnerDemand = {
		...PULL_REQUEST,
		id: "acme/app:1002:1:1",
		repository: { visibility: "private", ownerType: "organization" },
		isolationRequired: false,
	};
	return {
		"reference/errors.md": {
			"ci-fleet-codes": table(
				["Code", "Meaning", "Typical retry"],
				Object.entries(RUNNER_REFUSAL_CODES).map(([code, entry]) => [
					`\`${code}\``,
					entry.meaning,
					entry.retry,
				]),
			),
		},
		"ci/providers.md": {
			providers: providers(),
			eligibility: eligibility(),
			capabilities: capabilities(),
			pricing: pricing(),
			sources: sources(),
		},
		"ci/fleet-balancing.md": {
			"box-free": decision(decide(catalog(), PULL_REQUEST)),
			"box-full": decision(decide(catalog(BOX_FULL), PULL_REQUEST)),
			"private-trunk": decision(decide(catalog(BOX_FULL), privateTrunk)),
			queued: decision(
				decide(catalog(BOX_FULL), { ...PULL_REQUEST, queuedOnLabel: "hobo" }),
			),
			"budget-spent": decision(
				decide(catalog(BOX_FULL), PULL_REQUEST, {
					policy: policy(5_000_000),
					exposureMicros: 5_000_000,
				}),
			),
			"box-unhealthy": decision(
				decide(catalog({ "hobo-box": { healthy: false } }), PULL_REQUEST),
			),
		},
		"ci/route-table.md": {
			"routes-box-free": routes(catalog()),
			"routes-box-full": routes(catalog(BOX_FULL)),
		},
	};
}

const NOTICE =
	"<!-- Generated from the runner routing code by packages/ci/scripts/runner-routing-docs.ts. Do not edit by hand. -->";

/**
 * Pages whose generated blocks keep the notice they already carry. The fleet
 * work (design §8.5) gives this generator's rename only `ci/route-table.md`
 * and `ci/fleet-balancing.md`; the notice on these two pages is reworded by
 * the change that owns them, so regenerating here changes only their tables.
 */
const KEEP_NOTICE: ReadonlySet<string> = new Set([
	"reference/errors.md",
	"ci/providers.md",
]);

const NOTICE_LINE = /^<!-- Generated from .* Do not edit by hand\. -->$/u;

const marker = (id: string, edge: "start" | "end") =>
	`<!-- generated:${id}:${edge} -->`;

/** The page with every generated fragment replaced by its current output. */
export function applyRunnerRoutingDocs(
	page: string,
	fragments: Readonly<Record<string, string>>,
	options: { readonly keepNotice?: boolean } = {},
): string {
	let next = page;
	for (const [id, body] of Object.entries(fragments)) {
		const start = next.indexOf(marker(id, "start"));
		const end = next.indexOf(marker(id, "end"));
		if (start < 0 || end < start)
			throw new Error(`page has no generated:${id} markers`);
		const existing = next
			.slice(start + marker(id, "start").length, end)
			.split("\n")
			.find((line) => line.trim() !== "");
		const notice =
			options.keepNotice && existing !== undefined && NOTICE_LINE.test(existing)
				? existing
				: NOTICE;
		next = `${next.slice(0, start)}${marker(id, "start")}\n${notice}\n\n${body}\n\n${next.slice(end)}`;
	}
	return next;
}

export function runnerRoutingDocsPages(): {
	path: string;
	current: string;
	next: string;
}[] {
	return Object.entries(renderRunnerRoutingDocs()).map(([file, fragments]) => {
		const path = join(PAGES, file);
		const current = readFileSync(path, "utf8");
		return {
			path,
			current,
			next: applyRunnerRoutingDocs(current, fragments, {
				keepNotice: KEEP_NOTICE.has(file),
			}),
		};
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes("--check");
	const stale = runnerRoutingDocsPages().filter(
		(page) => page.current !== page.next,
	);
	for (const page of stale) {
		if (check) console.error(`stale generated section: ${page.path}`);
		else writeFileSync(page.path, page.next);
	}
	if (check && stale.length > 0) process.exit(1);
}
