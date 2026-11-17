/**
 * The dashboard's five views as pure functions: records in, markup out. No
 * clock, network or DOM; the browser client fetches the records and puts
 * the markup in the page, and the tests call these directly.
 *
 * Every view is read-only. The one control that leads to a change, the
 * Router view's "Edit in a pull request", is a link to GitHub's editor for
 * `.hobo/ci.json`; the dashboard itself never writes.
 */
import type {
	JobFact,
	MachineAdvert,
	RunFact,
	RunnerRouteDecision,
	RunnerRouteEvent,
} from "@hobo/ci";
import {
	diagnoseFailure,
	type FailureDiagnosis,
	summarizeDiagnosis,
} from "@hobo/ci/insights";
import {
	describeDecision,
	describeSkip,
	insightRunOf,
	orderAutoSize,
	orderRetryPolicy,
	type RunnerStepKey,
	skipsUnhealthy,
	stepKey,
} from "@hobo/ci/runner-order";
import { ago, duration, escapeHtml, minutes, percent, utc } from "./format.js";
import type { JobTimesReport, OrderReply, SignalReport } from "./read-api.js";
import {
	isHostedStep,
	isWhatIfRefusal,
	machineIsOnline,
	type WhatIfAnswer,
	type WhatIfQuestion,
} from "./what-if.js";

// public-contract: the five views, in navigation order.
export const DASHBOARD_VIEWS = [
	"runners",
	"router",
	"history",
	"performance",
	"signals",
] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const VIEW_TITLES: ReadonlyMap<DashboardView, string> = new Map<
	DashboardView,
	string
>([
	["runners", "Runners"],
	["router", "Router"],
	["history", "History"],
	["performance", "Performance"],
	["signals", "Signals"],
]);

// public-contract: the file a routing change edits, through a pull request.
export const PROJECT_CONFIG_PATH = ".hobo/ci.json";
// public-contract: the signer key id an adopted runner's advert carries (ADOPTED_RUNNER_SIGNER).
export const ADOPTED_RUNNER_SIGNER = "github:runner-labels";

/** GitHub's editor for the repository's `.hobo/ci.json`; saving there commits to a branch and opens a pull request. */
export function editOrderUrl(
	repository: string,
	ref: string | undefined,
): string {
	const [owner = "", name = ""] = repository.split("/");
	return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/edit/${encodeURIComponent(ref ?? "HEAD")}/${PROJECT_CONFIG_PATH}`;
}

function section(id: string, title: string, body: string): string {
	return `<section aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(title)}</h2>${body}</section>`;
}

/** An empty state; a trailing `hobo ...` command is shown as code. */
function empty(text: string): string {
	const command = /^(.*with )(hobo [a-z -]+)\.$/u.exec(text);
	return command?.[1] && command[2]
		? `<p class="empty">${escapeHtml(command[1])}<code>${escapeHtml(command[2])}</code>.</p>`
		: `<p class="empty">${escapeHtml(text)}</p>`;
}

function table(
	caption: string,
	head: readonly string[],
	rows: readonly (readonly string[])[],
): string {
	const header = head.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`);
	const body = rows.map(
		(row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`,
	);
	return `<div class="table-wrap"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${header.join("")}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
}

/** A lamp's colour: working, trouble, or unknown and waiting. */
export type LampState = "go" | "spark" | "faint";

/** What the newest decision says about one step of the order. */
export type StepHealth = Readonly<{ state: LampState; text: string }>;

function lamp(state: LampState, text: string): string {
	return `<span class="lamp-text" data-state="${state}"><span class="lamp" aria-hidden="true"></span>${escapeHtml(text)}</span>`;
}

// --- Runners -------------------------------------------------------------

export type RunnersModel = Readonly<{
	nowMs: number;
	machines: readonly MachineAdvert[];
	/** Recent route decisions, newest first; the fleet's state is read from them. */
	routes: readonly RunnerRouteEvent[];
}>;

/** One thing wrong with a machine; a lower rank is worse. */
export type Attention = Readonly<{ rank: number; why: string }>;

/** Why a machine needs someone, worst first; empty when it is fine. */
export function machineAttention(
	machine: MachineAdvert,
	nowMs: number,
): readonly Attention[] {
	const found: Attention[] = [];
	if (!machineIsOnline(machine, nowMs))
		found.push({
			rank: 0,
			why:
				machine.lastSeenMs > 1
					? `offline since ${utc(machine.lastSeenMs)}`
					: "offline",
		});
	if (machine.paused) found.push({ rank: 1, why: "paused" });
	if (machine.slots > 0 && machine.busy >= machine.slots)
		found.push({
			rank: 2,
			why: `every slot busy (${machine.busy} of ${machine.slots})`,
		});
	if (
		machine.isolation === "host" &&
		machine.signerKeyId !== ADOPTED_RUNNER_SIGNER
	)
		found.push({ rank: 3, why: "runs jobs on the host, not in a container" });
	return found;
}

function machineRows(
	machines: readonly MachineAdvert[],
	nowMs: number,
): readonly (readonly string[])[] {
	return machines.map((machine) => {
		const online = machineIsOnline(machine, nowMs);
		const state = machine.paused
			? lamp("faint", "paused")
			: online
				? lamp("go", "online")
				: lamp("spark", "offline");
		return [
			`<strong>${escapeHtml(machine.name)}</strong><br><code>${escapeHtml(machine.runsOn)}</code>`,
			state,
			`${escapeHtml(machine.busy)} of ${escapeHtml(machine.slots)}`,
			escapeHtml(`${machine.os} ${machine.arch}`),
			escapeHtml(machine.isolation),
			escapeHtml(machine.sharing === "anyone" ? "anyone" : "only me"),
			escapeHtml(
				`${machine.ownerLogin}${machine.repository ? ` · ${machine.repository}` : ""}`,
			),
			escapeHtml(
				machine.lastSeenMs > 1 ? ago(machine.lastSeenMs, nowMs) : "never",
			),
		];
	});
}

const MACHINE_HEAD = [
	"Machine",
	"State",
	"Busy",
	"System",
	"Isolation",
	"Shared with",
	"Owner",
	"Last seen",
];

/** What the route journal says about the HoBo fleet: jobs it took, and why it was passed over. */
/** The HoBo fleet as the route journal saw it. */
export type FleetSummary = Readonly<{
	took: number;
	full: number;
	off: number;
	needsIsolation: number;
	lastAtMs: number | undefined;
}>;

export function fleetSummary(
	routes: readonly RunnerRouteEvent[],
): FleetSummary {
	let took = 0;
	let full = 0;
	let off = 0;
	let needsIsolation = 0;
	let lastAtMs: number | undefined;
	for (const event of routes) {
		const decision = event.decision;
		if (!decision) continue;
		let mentioned = false;
		if (decision.step === "fleet" && decision.outcome === "routed") {
			took += 1;
			mentioned = true;
		}
		for (const skipped of decision.skipped) {
			if (skipped.key !== "fleet") continue;
			if (skipped.reason === "fleet_full") full += 1;
			if (skipped.reason === "fleet_off") off += 1;
			if (skipped.reason === "needs_isolation") needsIsolation += 1;
			mentioned = mentioned || skipped.reason !== "not_configured";
		}
		if (mentioned) lastAtMs ??= event.atMs;
	}
	return { took, full, off, needsIsolation, lastAtMs };
}

export function renderRunners(model: RunnersModel): string {
	const { machines, nowMs } = model;
	const attention = machines
		.flatMap((machine) =>
			machineAttention(machine, nowMs).map((found) => ({ machine, ...found })),
		)
		.sort((left, right) => left.rank - right.rank);
	const attentionBody =
		attention.length === 0
			? `<p class="all-clear">${lamp("go", "Nothing needs attention: every machine is online, unpaused and has a free slot.")}</p>`
			: `<ul class="attention">${attention
					.map(
						(entry) =>
							`<li><strong>${escapeHtml(entry.machine.name)}</strong> <code>${escapeHtml(entry.machine.id)}</code>: ${escapeHtml(entry.why)}</li>`,
					)
					.join("")}</ul>`;
	const connected = machines.filter(
		(machine) => machine.signerKeyId !== ADOPTED_RUNNER_SIGNER,
	);
	const adopted = machines.filter(
		(machine) => machine.signerKeyId === ADOPTED_RUNNER_SIGNER,
	);
	const fleet = fleetSummary(model.routes);
	const fleetBody =
		fleet.lastAtMs === undefined
			? empty("No recent route decision mentions the HoBo fleet.")
			: `<dl class="facts"><dt>Took</dt><dd>${fleet.took} jobs</dd><dt>Passed over, full</dt><dd>${fleet.full}</dd><dt>Passed over, off for the repository</dt><dd>${fleet.off}</dd><dt>Passed over, not isolated</dt><dd>${fleet.needsIsolation}</dd><dt>Last mentioned</dt><dd>${escapeHtml(ago(fleet.lastAtMs, nowMs))}</dd></dl><p class="meta">From the newest ${model.routes.length} route decisions.</p>`;
	return [
		section(
			"attention-heading",
			`Needs attention (${attention.length})`,
			attentionBody,
		),
		section(
			"machines-heading",
			`Machines (${connected.length})`,
			connected.length === 0
				? empty(
						"No machine is connected. Connect one with hobo ci machine connect.",
					)
				: table(
						"Connected machines",
						MACHINE_HEAD,
						machineRows(connected, nowMs),
					),
		),
		section(
			"adopted-heading",
			`Adopted runners (${adopted.length})`,
			adopted.length === 0
				? empty(
						"No self-hosted runner is adopted. Adopt one with hobo ci runners adopt.",
					)
				: table(
						"Adopted self-hosted runners",
						MACHINE_HEAD,
						machineRows(adopted, nowMs),
					),
		),
		section("fleet-heading", "Fleet", fleetBody),
	].join("");
}

// --- Router --------------------------------------------------------------

export type RouterModel = Readonly<{
	nowMs: number;
	order: OrderReply;
	/** Recent route decisions of the repository, newest first. */
	routes: readonly RunnerRouteEvent[];
	question: WhatIfQuestion;
	/** The what-if answer, once the person has asked. */
	answer: WhatIfAnswer | undefined;
}>;

/** A step's limit in words. */
function stepLimit(
	step: Readonly<{
		key: string;
		minutesLimitPercent: number;
		spendLimitUsd: number;
	}>,
): string {
	if (step.minutesLimitPercent > 0)
		return `while under ${step.minutesLimitPercent}% of included minutes`;
	if (step.spendLimitUsd > 0)
		return `while under $${step.spendLimitUsd} this month`;
	return "no limit";
}

/** What the newest decision mentioning a step says about it. */
export function stepHealth(
	key: RunnerStepKey,
	routes: readonly RunnerRouteEvent[],
	nowMs: number,
): StepHealth {
	for (const event of routes) {
		const decision = event.decision;
		if (!decision) continue;
		if (decision.step === key && decision.outcome !== "none") {
			if (decision.unhealthyFallback)
				return {
					state: "spark",
					text: `took a job while failing to start jobs, ${ago(event.atMs, nowMs)}`,
				};
			return {
				state: "go",
				text: `${decision.outcome === "waiting" ? "queued a job" : "took a job"} ${ago(event.atMs, nowMs)}`,
			};
		}
		const skipped = decision.skipped.find(
			(entry) => entry.key === key && entry.reason !== "not_configured",
		);
		if (skipped)
			return {
				state: skipped.reason === "provider_unhealthy" ? "spark" : "faint",
				text: `passed over ${ago(event.atMs, nowMs)}: ${describeSkip(skipped).slice(key.length + 2)}`,
			};
	}
	return { state: "faint", text: "no recent decision" };
}

function decisionLine(decision: RunnerRouteDecision): string {
	const lampState =
		decision.outcome === "none"
			? "spark"
			: decision.outcome === "waiting"
				? "faint"
				: "go";
	const skipped =
		decision.skipped.length === 0
			? ""
			: `<ul class="skipped">${decision.skipped
					.map((entry) => `<li>${escapeHtml(describeSkip(entry))}</li>`)
					.join("")}</ul>`;
	const outside =
		decision.notInOrder.length === 0
			? ""
			: `<p class="meta">Not in the order, so never tried: ${escapeHtml(decision.notInOrder.join(", "))}</p>`;
	return `${lamp(lampState, describeDecision(decision))}${skipped}${outside}`;
}

function whatIfForm(model: RouterModel): string {
	const { question, order } = model;
	const disabled = model.order.problem === "" ? "" : " disabled";
	const fields = order.order.steps
		.map((step) => {
			const key = stepKey(step);
			const value = question.labels.get(key) ?? "";
			const unhealthy = isHostedStep(key)
				? `<label class="check"><input type="checkbox" name="unhealthy" value="${escapeHtml(key)}"${question.unhealthy.has(key) ? " checked" : ""}> ${escapeHtml(key)} has stopped starting jobs</label>`
				: "";
			return `<div class="field"><label for="what-if-${escapeHtml(key)}">${escapeHtml(key)} labels</label><input id="what-if-${escapeHtml(key)}" name="label:${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="not named" autocomplete="off">${unhealthy}</div>`;
		})
		.join("");
	const answer =
		model.answer === undefined
			? `<p class="note" id="what-if-answer" role="status" tabindex="-1">Set the inputs and run the walk. Nothing is sent to the relay.</p>`
			: isWhatIfRefusal(model.answer)
				? `<div id="what-if-answer" class="answer" role="status" tabindex="-1" data-state="refused">${lamp("spark", model.answer.refused)}</div>`
				: `<div id="what-if-answer" class="answer" role="status" tabindex="-1">${decisionLine(model.answer)}</div>`;
	return `<form id="what-if" class="what-if" novalidate>
<fieldset${disabled}><legend>What if a relay job asked now</legend>
${fields}
<div class="field"><label for="what-if-started-by">Started by (GitHub user id)</label><input id="what-if-started-by" name="startedBy" value="${escapeHtml(question.startedBy)}" inputmode="numeric" pattern="[0-9]{0,20}" autocomplete="off"></div>
<div class="field"><label for="what-if-minutes">Included minutes used (%)</label><input id="what-if-minutes" name="minutesUsedPercent" type="number" min="0" max="100" value="${question.minutesUsedPercent === undefined ? "" : escapeHtml(question.minutesUsedPercent)}" placeholder="not measured"></div>
<label class="check"><input type="checkbox" name="public"${question.public ? " checked" : ""}> The repository is public</label>
<label class="check"><input type="checkbox" name="fork"${question.fork ? " checked" : ""}> The run comes from a fork</label>
<label class="check"><input type="checkbox" name="fleetTaking"${question.fleetTaking ? " checked" : ""}> The fleet has room</label>
<button type="submit">Run the walk</button>
</fieldset>
</form>${answer}`;
}

export function renderRouter(model: RouterModel): string {
	const { order, nowMs } = model;
	const problem =
		order.problem === ""
			? ""
			: `<p class="problem" role="alert">${lamp("spark", `The committed order does not parse: ${order.problem}. Relay jobs fail with this sentence until it is fixed.`)}</p>`;
	const retry = orderRetryPolicy(order.order);
	const steps = table(
		"The committed runner order, walked top to bottom",
		["#", "Step", "Limit", "Health"],
		order.order.steps.map((step, index) => {
			const health = stepHealth(stepKey(step), model.routes, nowMs);
			return [
				String(index + 1),
				`<strong>${escapeHtml(step.key)}</strong>`,
				escapeHtml(stepLimit(step)),
				lamp(health.state, health.text),
			];
		}),
	);
	const rules = `<dl class="facts"><dt>auto size</dt><dd>${orderAutoSize(order.order)} vCPUs</dd><dt>Skips a runner type that stopped starting jobs</dt><dd>${skipsUnhealthy(order.order) ? "yes" : "no"}</dd><dt>Retry</dt><dd>${retry.enabled ? `on, ${escapeHtml(retry.runner)} runner, at most ${retry.max}` : "off"}</dd></dl>`;
	const edit = `<p class="edit"><a class="action" href="${escapeHtml(editOrderUrl(order.repository, order.ref))}" target="_blank" rel="noopener noreferrer" data-edit="runner-order">Edit in a pull request</a></p><p class="note">The order lives in <code>${PROJECT_CONFIG_PATH}</code> under <code>runnerOrder</code>. Editing opens GitHub's editor for that file: save the change on a new branch and open a pull request. The relay reads the committed order, so nothing changes until the pull request merges.</p>`;
	const decisions =
		model.routes.length === 0
			? empty("No route decision is journaled for this repository yet.")
			: `<ol class="decisions">${model.routes
					.filter((event) => event.decision !== undefined)
					.map((event) => {
						const request = event.request;
						const where = request
							? `run ${request.runId} attempt ${request.runAttempt} · ${request.job} · ${request.event}`
							: event.jobId;
						return `<li><p class="meta">${escapeHtml(utc(event.atMs))} · ${escapeHtml(where)} · ${escapeHtml(event.mode)} mode · ${escapeHtml(event.node)}</p>${event.decision ? decisionLine(event.decision) : ""}</li>`;
					})
					.join("")}</ol>`;
	return [
		section(
			"order-heading",
			`Runner order · ${order.repository}`,
			`${problem}${steps}${rules}${edit}`,
		),
		section("what-if-heading", "What if", whatIfForm(model)),
		section("decisions-heading", "Recent decisions", decisions),
	].join("");
}

// --- History -------------------------------------------------------------

export type HistoryModel = Readonly<{
	nowMs: number;
	runs: readonly RunFact[];
	/** The run attempt opened, with its jobs. */
	selected: RunFact | undefined;
}>;

/** The hash route of one run attempt in the History view. */
export function runHash(
	run: Readonly<{ repository: string; id: number; attempt: number }>,
): string {
	return `#/history/${run.repository}/${run.id}/${run.attempt}`;
}

function conclusionLamp(conclusion: string): string {
	if (conclusion === "success") return lamp("go", "success");
	if (
		conclusion === "failure" ||
		conclusion === "timed_out" ||
		conclusion === "startup_failure"
	)
		return lamp("spark", conclusion.replaceAll("_", " "));
	return lamp(
		"faint",
		conclusion === "" ? "running" : conclusion.replaceAll("_", " "),
	);
}

/** The diagnosis of each failed job of a run attempt, from its steps; logs are not read. */
export function runDiagnoses(
	run: RunFact,
): ReadonlyMap<number, FailureDiagnosis> {
	const diagnoses = new Map<number, FailureDiagnosis>();
	for (const job of insightRunOf(run).jobs)
		if (job.conclusion === "failure" || job.conclusion === "timed_out")
			diagnoses.set(job.id, diagnoseFailure({ job }));
	return diagnoses;
}

function jobBlock(
	job: JobFact,
	diagnosis: FailureDiagnosis | undefined,
): string {
	const waited =
		job.startedAtMs === undefined
			? undefined
			: job.startedAtMs - job.queuedAtMs;
	const ran =
		job.startedAtMs === undefined || job.completedAtMs === undefined
			? undefined
			: job.completedAtMs - job.startedAtMs;
	const steps = table(
		`Steps of ${job.name}`,
		["#", "Step", "Result", "Took"],
		job.steps.map((step) => [
			escapeHtml(step.number),
			escapeHtml(step.name),
			conclusionLamp(step.conclusion),
			escapeHtml(
				duration(
					step.startedAtMs === undefined || step.completedAtMs === undefined
						? undefined
						: step.completedAtMs - step.startedAtMs,
				),
			),
		]),
	);
	const diagnosed =
		diagnosis === undefined
			? ""
			: `<div class="diagnosis" data-kind="${escapeHtml(diagnosis.kind)}"><p><strong>${escapeHtml(summarizeDiagnosis(diagnosis))}</strong></p>${
					diagnosis.evidence.length === 0
						? `<p class="note">No evidence in the steps; the log is not read here. Read it with <code>gh run view --log-failed</code>.</p>`
						: `<p class="meta">Evidence:</p><ul>${diagnosis.evidence.map((line) => `<li><code>${escapeHtml(line)}</code></li>`).join("")}</ul>`
				}</div>`;
	return `<article class="job" data-conclusion="${escapeHtml(job.conclusion)}"><h3>${escapeHtml(job.name)}</h3><p class="meta">${conclusionLamp(job.conclusion)} · on <code>${escapeHtml(job.runnerName ?? job.labels.join(", "))}</code> · waited ${escapeHtml(duration(waited))} · ran ${escapeHtml(duration(ran))}</p>${diagnosed}${steps}</article>`;
}

export function renderHistory(model: HistoryModel): string {
	const { runs, nowMs, selected } = model;
	const list =
		runs.length === 0
			? empty("No run is stored for this account yet.")
			: table(
					"Stored run attempts, newest first",
					["Run", "Workflow", "Result", "Branch", "Event", "Took", "When"],
					runs.map((run) => [
						`<a href="${escapeHtml(runHash(run))}">${escapeHtml(run.repository)} #${escapeHtml(run.id)}${run.attempt > 1 ? ` attempt ${escapeHtml(run.attempt)}` : ""}</a>`,
						escapeHtml(run.workflow),
						conclusionLamp(run.conclusion),
						escapeHtml(run.branch),
						escapeHtml(run.event),
						escapeHtml(
							duration(
								run.completedAtMs === undefined
									? undefined
									: run.completedAtMs - run.createdAtMs,
							),
						),
						escapeHtml(ago(run.createdAtMs, nowMs)),
					]),
				);
	const open =
		selected === undefined
			? ""
			: section(
					"run-heading",
					`${selected.workflow} · ${selected.repository} #${selected.id} attempt ${selected.attempt}`,
					(() => {
						const diagnoses = runDiagnoses(selected);
						return selected.jobs.length === 0
							? empty("This run attempt has no stored jobs.")
							: selected.jobs
									.map((job) => jobBlock(job, diagnoses.get(job.id)))
									.join("");
					})(),
				);
	return `${open}${section("runs-heading", "Runs", list)}`;
}

// --- Performance ---------------------------------------------------------

export function renderPerformance(report: JobTimesReport): string {
	if (report.runs === 0)
		return section(
			"performance-heading",
			"Performance",
			empty("No run is stored for this window yet."),
		);
	const workflows = table(
		"Times by workflow",
		[
			"Workflow",
			"Runs",
			"Success",
			"Median",
			"p90",
			"Median wait",
			"Slowest job",
		],
		report.workflows.map((row) => [
			escapeHtml(row.workflow),
			escapeHtml(row.runs),
			escapeHtml(percent(row.successRate)),
			escapeHtml(duration(row.medianMs)),
			escapeHtml(duration(row.p90Ms)),
			escapeHtml(duration(row.medianWaitMs)),
			escapeHtml(row.slowestJob ?? "–"),
		]),
	);
	const jobs = table(
		"Times by job and runner",
		[
			"Job",
			"Runner",
			"Runs",
			"Median",
			"p90",
			"Confidence",
			"Against ubuntu-latest",
		],
		report.jobs.flatMap((job) =>
			job.runners.map((runner) => {
				const ratio = job.speedup.find(
					(entry) => entry.key === runner.key,
				)?.ratio;
				const fastest =
					job.fastest === runner.key
						? ' <span class="badge">fastest</span>'
						: "";
				return [
					`${escapeHtml(job.job)}<br><span class="meta">${escapeHtml(job.workflow)}</span>`,
					`<code>${escapeHtml(runner.key)}</code>${fastest}`,
					escapeHtml(runner.runs),
					escapeHtml(duration(runner.medianRunMs)),
					escapeHtml(duration(runner.p90RunMs)),
					escapeHtml(runner.confidence),
					escapeHtml(
						ratio === undefined ? "–" : `${Math.round(ratio * 100) / 100}×`,
					),
				];
			}),
		),
	);
	const runners = table(
		"Times by runner",
		[
			"Runner",
			"Jobs",
			"Started",
			"Median wait",
			"Median run",
			"p90 run",
			"Success",
		],
		report.runners.map((row) => [
			`<code>${escapeHtml(row.key)}</code>`,
			escapeHtml(row.jobs),
			escapeHtml(`${row.started} (${percent(row.startedShare)})`),
			escapeHtml(duration(row.medianWaitMs)),
			escapeHtml(duration(row.medianRunMs)),
			escapeHtml(duration(row.p90RunMs)),
			escapeHtml(percent(row.successRate)),
		]),
	);
	const window = `<p class="meta">${escapeHtml(report.runs)} stored runs since ${escapeHtml(utc(report.sinceMs))}.</p>`;
	return [
		section("workflows-heading", "Workflows", `${window}${workflows}`),
		section("jobs-heading", "Jobs", jobs),
		section("runners-times-heading", "Runners", runners),
	].join("");
}

// --- Signals -------------------------------------------------------------

// public-contract: what each of the nine signals means, in a sentence.
export const SIGNAL_TITLES: ReadonlyMap<string, string> = new Map([
	[
		"no-concurrency",
		"Runs of the same branch overlap with no concurrency group",
	],
	["same-commit", "The same commit is built more than once"],
	["short-jobs", "Billed jobs finish in under a minute"],
	["queue-waits", "Jobs wait more than a minute for a runner"],
	["slowest-job", "One job runs on alone after the rest finish"],
	["flaky-jobs", "A job fails and then passes on the same commit"],
	["runner-failures", "Jobs fail before their own steps run"],
	["docs-changes", "Documentation-only changes run the full workflow"],
	["wide-fanout", "Runs start ten or more jobs at once"],
]);

function trendBars(report: SignalReport): string {
	if (report.trend.length === 0)
		return empty("No day in the window has a stored run.");
	const most = Math.max(...report.trend.map((day) => day.minutes), 0.0001);
	return `<ol class="trend" aria-label="Signal minutes per day">${report.trend
		.map((day) => {
			const height = Math.max(4, Math.round((day.minutes / most) * 100));
			return `<li title="${escapeHtml(`${day.day}: ${minutes(day.minutes)} of ${minutes(day.jobMinutes)} in ${day.runs} runs`)}"><span class="bar" style="height:${height}%"></span><span class="day">${escapeHtml(day.day.slice(5))}</span></li>`;
		})
		.join("")}</ol>`;
}

export function renderSignals(report: SignalReport): string {
	// Signals over their threshold first, then the rest in report order.
	const signals = [
		...report.signals.signals.filter((signal) => signal.shown),
		...report.signals.signals.filter((signal) => !signal.shown),
	];
	const list =
		signals.length === 0
			? empty("No run is stored for this window yet.")
			: `<ul class="signals">${signals
					.map((signal) => {
						const rows =
							signal.rows.length === 0
								? ""
								: `<ul class="offenders">${signal.rows
										.map(
											(row) =>
												`<li><code>${escapeHtml(row.key)}</code>: ${escapeHtml(minutes(row.minutes))}, ${escapeHtml(row.occurrences)} times</li>`,
										)
										.join("")}</ul>`;
						return `<li class="signal" data-shown="${signal.shown}"><p>${lamp(signal.shown ? "spark" : "faint", SIGNAL_TITLES.get(signal.id) ?? signal.id)}</p><p class="meta">${escapeHtml(signal.id)} · ${escapeHtml(signal.area)} · ${escapeHtml(minutes(signal.minutes))} · ${escapeHtml(signal.occurrences)} times${signal.shown ? "" : " · below the threshold"}</p>${rows}</li>`;
					})
					.join("")}</ul>`;
	const breakdown = Object.entries(report.by)
		.map(([dimension, slices]) =>
			slices.length === 0
				? ""
				: table(
						`Signal minutes by ${dimension}`,
						[dimension, "Runs", "Signal minutes", "Job minutes"],
						slices.map((slice) => [
							`<code>${escapeHtml(slice.key)}</code>`,
							escapeHtml(slice.runs),
							escapeHtml(minutes(slice.minutes)),
							escapeHtml(minutes(slice.jobMinutes)),
						]),
					),
		)
		.join("");
	return [
		section(
			"signals-heading",
			"The nine signals",
			`<p class="meta">${escapeHtml(report.runs)} stored runs since ${escapeHtml(utc(report.sinceMs))}, ${escapeHtml(minutes(report.signals.totalJobMinutes))} of job time.</p>${list}`,
		),
		section(
			"breakdown-heading",
			"Breakdown",
			breakdown === "" ? empty("Nothing to break down yet.") : breakdown,
		),
		section("trend-heading", "Trend", trendBars(report)),
	].join("");
}
