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
import { isQuoteVector, QuoteEngine } from "@hobo/pricing";
import {
	FLEET_REFUSAL_CODES,
	RUNNER_FINANCIAL_MODELS,
	type RunnerFinancialModel,
	runnerQuoteScenario,
} from "../src/fleet/index.js";

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

const PAGES = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../site/src/pages",
);

// ------------------------------------------------------------ formatting

function table(header: readonly string[], rows: readonly string[][]): string {
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

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

/** Fragment id to markdown, grouped by the page that holds it. */
export function renderFleetDocs() {
	return {
		"reference/errors.md": {
			"ci-fleet-codes": table(
				["Code", "Meaning", "Typical retry"],
				Object.entries(FLEET_REFUSAL_CODES).map(([code, entry]) => [
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
	};
}

const NOTICE =
	"<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->";

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
		next = `${next.slice(0, start)}${marker(id, "start")}\n${NOTICE}\n\n${body}\n\n${next.slice(end)}`;
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
