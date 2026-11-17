/**
 * `hobo ci init`: which jobs of a GitHub Actions workflow can move to the HoBo
 * CI fleet, and the edit that moves them.
 *
 * A job opts into the fleet by naming the fleet's label in `runs-on`. The plan
 * reads one workflow file and gives every job a verdict: `ready` (a
 * GitHub-hosted Linux x64 job whose label can be swapped), `routed` (already
 * on a fleet label) or `skipped`, with the reason. A job is skipped whenever
 * swapping the label could change what it does: its machine is chosen while
 * the workflow runs, it wants another operating system, it already runs
 * somewhere deliberate, or it looks like a deploy, which is left on the runner
 * that holds its secrets today unless the owner asks otherwise.
 *
 * Applying a plan changes the bytes of the chosen `runs-on` values and nothing
 * else. The file is never written back out from its parsed form, so comments,
 * blank lines, quoting, indentation and line endings stay as they were, and
 * the label that was there is left in a trailing comment so the change can be
 * undone by hand.
 *
 * Pure functions: no filesystem, clock or network. The caller reads the file
 * and writes the result.
 */
import { runnerProviderOfLabel } from "@hobo/ci";
import {
	type Document,
	isAlias,
	isMap,
	isNode,
	isScalar,
	isSeq,
	type Node,
	type Pair,
	parseDocument,
	type Range,
	type Scalar,
	visit,
	type YAMLMap,
	type YAMLSeq,
} from "yaml";

// public-contract: the fleet labels a job may already be routed to.
export const FLEET_RUNNER_LABELS = ["hobo", "hobo-trunk", "hobo-box"] as const;

// public-contract: the label a job is given when the caller names none.
export const DEFAULT_FLEET_LABEL = "hobo";

// public-contract: every reason a job is left as it is.
export const WORKFLOW_SKIP_REASONS = [
	"reusable_workflow",
	"expression",
	"label_group",
	"not_linux_x64",
	"provider_label",
	"self_hosted",
	"uses_secrets",
	"routes_jobs",
	"no_runs_on",
] as const;
export type WorkflowSkipReason = (typeof WORKFLOW_SKIP_REASONS)[number];

// public-contract: every caution attached to a job that is ready to move.
export const WORKFLOW_WARNINGS = [
	"needs_docker",
	"installs_packages",
	"moving_image",
	"matrix",
] as const;
export type WorkflowWarning = (typeof WORKFLOW_WARNINGS)[number];

export type WorkflowJobPlan = Readonly<{
	file: string;
	/** The job id: its key under `jobs:`. */
	job: string;
	/** The job's `name:` when it is a plain string. */
	name: string | undefined;
	verdict: "ready" | "routed" | "skipped";
	/** The current `runs-on` as written: a list's labels joined with `, `, and empty when absent. */
	runsOn: string;
	/** Set only when the job is skipped. */
	reason: WorkflowSkipReason | undefined;
	/** Set only when the job is ready, in `WORKFLOW_WARNINGS` order. */
	warnings: readonly WorkflowWarning[];
}>;

export type WorkflowPlan = Readonly<{
	file: string;
	/** Every job, in file order. Empty when `error` is set. */
	jobs: readonly WorkflowJobPlan[];
	/** One sentence when the file is not valid YAML or has no `jobs:` mapping. */
	error: string | undefined;
}>;

export type WorkflowInitOptions = Readonly<{
	/** The label written into `runs-on`. A job already on it counts as routed. */
	fleetLabel: string;
	/** Deploy-like jobs are ready instead of skipped as `uses_secrets`. */
	includeSecretJobs: boolean;
}>;

export type WorkflowApplyResult = Readonly<{
	/** The new file text. The input text when nothing was rewritten. */
	source: string;
	/** Job ids rewritten, in file order. */
	changed: readonly string[];
	/** Selected jobs that were not rewritten, each with why. */
	refused: readonly Readonly<{ job: string; why: string }>[];
}>;

/** Selects every ready job when given in place of a job id. */
const EVERY_READY_JOB = "all";

const EXPRESSION_OPEN = "${{";

const SECRET_REFERENCE =
	/\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\]|\[)/giu;

const PACKAGE_INSTALL = /\b(apt-get|apt|yum|dnf|apk)\s+(-\S+\s+)*install\b/u;

const SUDO = /\bsudo\b/u;

/** A label that reads back as the same string when written without quotes. */
const PLAIN_LABEL = /^[A-Za-z][A-Za-z0-9._-]*$/u;

/** Words YAML reads as a boolean or as nothing rather than as a string. */
const YAML_KEYWORDS: ReadonlySet<string> = new Set([
	"true",
	"false",
	"null",
	"yes",
	"no",
	"on",
	"off",
]);

const ALREADY_ROUTED = "already routed";

const NO_SUCH_JOB = "no such job";

const SHARED_THROUGH_ANCHOR =
	"its runs-on is shared through a YAML anchor, so rewriting it would change more than this job; change it by hand";

const NOT_LOCATED =
	"its runs-on could not be located in the file; change it by hand";

const WOULD_NOT_READ_BACK =
	"rewriting it would not leave a workflow that reads back with the job routed; change it by hand";

/** A node an alias can stand for: anything but another alias. */
type Value = Scalar | YAMLMap | YAMLSeq;

/** One parsed workflow file and how it is being read. */
type Workflow = Readonly<{
	file: string;
	source: string;
	doc: Document;
	/** The top-level mapping: its `permissions` and `env` reach every job. */
	root: YAMLMap;
	/** The `jobs:` mapping is one a YAML anchor shares with another place. */
	jobsShared: boolean;
	settings: WorkflowInitOptions;
}>;

/** What a job's `runs-on` says. */
type RunsOn = Readonly<{
	form: "absent" | "mapping" | "labels";
	/** Every label written, in order. Empty unless `form` is `labels`. */
	labels: readonly string[];
	/** The label when `runs-on` is one string, or a list holding one string. */
	label: string | undefined;
	/** What the plan reports as the current `runs-on`. */
	text: string;
}>;

type Standing = Readonly<{
	verdict: WorkflowJobPlan["verdict"];
	reason: WorkflowSkipReason | undefined;
}>;

/** The edit that moves a job, or why it cannot be made. */
type Rewrite =
	| Readonly<{
			kind: "splice";
			/** The bytes `[start, end)` of the file are replaced. */
			start: number;
			end: number;
			/** Written before the label: a space where the label needs one to stay a value. */
			lead: string;
			/** The quote character the label was written in, kept for the new one. */
			quote: string;
			/** The label being replaced. */
			was: string;
	  }>
	| Readonly<{ kind: "refuse"; why: string }>;

type InspectedJob = Readonly<{ plan: WorkflowJobPlan; rewrite: Rewrite }>;

type WorkflowReading = Readonly<{
	error: string | undefined;
	jobs: readonly InspectedJob[];
}>;

const ABSENT: RunsOn = {
	form: "absent",
	labels: [],
	label: undefined,
	text: "",
};

const READY: Standing = { verdict: "ready", reason: undefined };

const ROUTED: Standing = { verdict: "routed", reason: undefined };

function skipped(reason: WorkflowSkipReason): Standing {
	return { verdict: "skipped", reason };
}

function refuse(why: string): Rewrite {
	return { kind: "refuse", why };
}

function settingsOf(
	options: Partial<WorkflowInitOptions> | undefined,
): WorkflowInitOptions {
	const fleetLabel = options?.fleetLabel?.trim() ?? "";
	return {
		fleetLabel: fleetLabel.length > 0 ? fleetLabel : DEFAULT_FLEET_LABEL,
		includeSecretJobs: options?.includeSecretJobs ?? false,
	};
}

/** The node an alias stands for. Any other node is itself. */
function follow(doc: Document, node: Node | undefined): Value | undefined {
	return isAlias(node) ? node.resolve(doc) : node;
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/** The value under `key` as written, before any alias is followed. */
function writtenUnder(map: YAMLMap, key: string): Node | undefined {
	const value = pairOf(map, key)?.value;
	return isNode(value) ? value : undefined;
}

function valueUnder(
	workflow: Workflow,
	map: YAMLMap,
	key: string,
): Value | undefined {
	return follow(workflow.doc, writtenUnder(map, key));
}

/**
 * A scalar's text when YAML read it as a string. A number, a boolean and an
 * empty value are not strings, and neither is a mapping or a list.
 */
function stringOf(node: Node | undefined): string | undefined {
	return isScalar(node) && node.value === node.source ? node.source : undefined;
}

function sliceOf(source: string, node: Node): string {
	const range = node.range;
	return range ? source.slice(range[0], range[1]) : "";
}

/** A node's source on one line, for reporting a `runs-on` that is not a label. */
function onOneLine(source: string, node: Node): string {
	return sliceOf(source, node).trim().replace(/\s+/gu, " ");
}

/**
 * The source text of a node and of everything it reaches through aliases. An
 * `env: *deploy_env` is two characters where it is used, and what it stands
 * for is written somewhere else in the file.
 */
function reachableText(workflow: Workflow, from: Node): readonly string[] {
	const seen = new Set<Node>();
	const pending: Node[] = [from];
	const texts: string[] = [];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (seen.has(node)) continue;
		seen.add(node);
		texts.push(sliceOf(workflow.source, node));
		visit(node, {
			Alias: (_key, alias) => {
				const target = alias.resolve(workflow.doc);
				if (target !== undefined) pending.push(target);
			},
		});
	}
	return texts;
}

function namesSecret(text: string): boolean {
	return [...text.matchAll(SECRET_REFERENCE)].some(
		(match) => (match[1] ?? match[3])?.toUpperCase() !== "GITHUB_TOKEN",
	);
}

/** `permissions` that let a job write anywhere or sign in to a cloud as the repository. */
function grantsDeployPermissions(workflow: Workflow, holder: YAMLMap): boolean {
	const permissions = valueUnder(workflow, holder, "permissions");
	if (stringOf(permissions) === "write-all") return true;
	return (
		isMap(permissions) &&
		stringOf(valueUnder(workflow, permissions, "id-token")) === "write"
	);
}

/**
 * A job that deploys or holds a secret: it names an environment, has
 * `write-all` or `id-token: write` permissions, or reads a secret other than
 * `GITHUB_TOKEN`. The workflow's own `permissions` count for a job that sets
 * none, and the workflow's own `env` counts for every job, because that is
 * what GitHub hands the job.
 */
function isDeployLike(workflow: Workflow, job: YAMLMap): boolean {
	if (pairOf(job, "environment") !== undefined) return true;
	if (stringOf(valueUnder(workflow, job, "secrets")) === "inherit") return true;
	const permissionsHolder =
		pairOf(job, "permissions") !== undefined ? job : workflow.root;
	if (grantsDeployPermissions(workflow, permissionsHolder)) return true;
	const workflowEnv = writtenUnder(workflow.root, "env");
	return [
		...reachableText(workflow, job),
		...(workflowEnv === undefined ? [] : reachableText(workflow, workflowEnv)),
	].some(namesSecret);
}

function readRunsOn(workflow: Workflow, job: YAMLMap): RunsOn {
	const node = valueUnder(workflow, job, "runs-on");
	if (node === undefined) return ABSENT;
	if (isMap(node)) {
		return {
			form: "mapping",
			labels: [],
			label: undefined,
			text: onOneLine(workflow.source, node),
		};
	}
	if (isScalar(node)) {
		const label = node.source ?? "";
		if (node.value === null || label.trim().length === 0) return ABSENT;
		return { form: "labels", labels: [label], label, text: label };
	}
	const elements = node.items.map((item) =>
		follow(workflow.doc, isNode(item) ? item : undefined),
	);
	if (elements.length === 0) return ABSENT;
	const labels = elements.map((element) => {
		if (isScalar(element)) return element.source ?? "";
		return element === undefined ? "" : onOneLine(workflow.source, element);
	});
	const only = elements.length === 1 ? elements[0] : undefined;
	return {
		form: "labels",
		labels,
		label: isScalar(only) ? (only.source ?? "") : undefined,
		text: labels.join(", "),
	};
}

/** Where one label already sends a job, before the job's own content is read. */
function labelStanding(label: string, settings: WorkflowInitOptions): Standing {
	const lower = label.toLowerCase();
	if (
		FLEET_RUNNER_LABELS.some((fleet) => fleet === lower) ||
		lower === settings.fleetLabel.toLowerCase()
	) {
		return ROUTED;
	}
	// A label with a space or a line break in it is nobody's known label, even
	// when trimming it would make it one.
	if (lower === "self-hosted" || /\s/u.test(label)) {
		return skipped("self_hosted");
	}
	const provider = runnerProviderOfLabel(label);
	if (provider === undefined) return skipped("self_hosted");
	if (provider !== "github") return skipped("provider_label");
	if (
		lower.startsWith("windows-") ||
		lower.startsWith("macos-") ||
		lower.endsWith("-arm")
	) {
		return skipped("not_linux_x64");
	}
	return READY;
}

/** The verdict rules, first match wins. */
function standingOf(
	workflow: Workflow,
	job: YAMLMap,
	runsOn: RunsOn,
): Standing {
	if (pairOf(job, "uses") !== undefined) return skipped("reusable_workflow");
	if (runsOn.form === "absent") return skipped("no_runs_on");
	if (runsOn.form === "mapping") return skipped("label_group");
	if (runsOn.labels.some((label) => label.includes(EXPRESSION_OPEN))) {
		return skipped("expression");
	}
	if (runsOn.label === undefined) {
		const leadsWithSelfHosted =
			runsOn.labels.length > 1 &&
			runsOn.labels[0]?.toLowerCase() === "self-hosted";
		return skipped(leadsWithSelfHosted ? "self_hosted" : "label_group");
	}
	const standing = labelStanding(runsOn.label, workflow.settings);
	if (standing.verdict !== "ready") return standing;
	if (!workflow.settings.includeSecretJobs && isDeployLike(workflow, job)) {
		return skipped("uses_secrets");
	}
	return READY;
}

function stepsOf(workflow: Workflow, job: YAMLMap): readonly YAMLMap[] {
	const steps = valueUnder(workflow, job, "steps");
	if (!isSeq(steps)) return [];
	return steps.items.flatMap((item) => {
		const step = follow(workflow.doc, isNode(item) ? item : undefined);
		return isMap(step) ? [step] : [];
	});
}

function warningsOf(
	workflow: Workflow,
	job: YAMLMap,
	label: string,
): readonly WorkflowWarning[] {
	const steps = stepsOf(workflow, job);
	const scripts = steps.flatMap(
		(step) => stringOf(valueUnder(workflow, step, "run")) ?? [],
	);
	const actions = steps.flatMap(
		(step) => stringOf(valueUnder(workflow, step, "uses")) ?? [],
	);
	const strategy = valueUnder(workflow, job, "strategy");
	const found = new Set<WorkflowWarning>();
	if (
		pairOf(job, "services") !== undefined ||
		pairOf(job, "container") !== undefined ||
		actions.some((action) => action.startsWith("docker://"))
	) {
		found.add("needs_docker");
	}
	if (
		scripts.some((script) => PACKAGE_INSTALL.test(script) || SUDO.test(script))
	) {
		found.add("installs_packages");
	}
	if (label.toLowerCase() === "ubuntu-latest") found.add("moving_image");
	if (isMap(strategy) && pairOf(strategy, "matrix") !== undefined) {
		found.add("matrix");
	}
	return WORKFLOW_WARNINGS.filter((warning) => found.has(warning));
}

/** Other places in the file can stand for this node, so editing it edits them too. */
function isAnchored(node: Node): boolean {
	return !isAlias(node) && node.anchor !== undefined;
}

function columnOf(source: string, offset: number): number {
	return offset - (source.lastIndexOf("\n", offset - 1) + 1);
}

/**
 * A splice over `[start, end)`, cut back so it never takes the line break or
 * the spaces a value's range can end with.
 */
function spliceOver(
	source: string,
	span: readonly [number, number],
	lead: string,
	quote: string,
	was: string,
): Rewrite {
	const [start, end] = span;
	return {
		kind: "splice",
		start,
		end: start + source.slice(start, end).trimEnd().length,
		lead,
		quote,
		was,
	};
}

/**
 * A block list of one label becomes the label on the key's own line. When a
 * comment sits between the key and the list, the label takes the place of the
 * `- label` item instead, so the comment stays where it is.
 */
function blockListRewrite(
	source: string,
	keyRange: Range,
	listRange: Range,
	itemRange: Range,
	was: string,
): Rewrite {
	const afterColon = source.indexOf(":", keyRange[1]) + 1;
	const dash = listRange[0];
	if (afterColon === 0 || afterColon > dash) return refuse(NOT_LOCATED);
	if (source.slice(afterColon, dash).trim().length === 0) {
		return spliceOver(source, [afterColon, itemRange[1]], " ", "", was);
	}
	// A value on its own line has to sit deeper than its key. A list may start
	// in the key's column; a plain label may not.
	const lead =
		columnOf(source, dash) > columnOf(source, keyRange[0]) ? "" : " ";
	return spliceOver(source, [dash, itemRange[1]], lead, "", was);
}

/** The quote character a label is written in, when it is written in one. */
function quoteOf(node: Node): string {
	if (!isScalar(node)) return "";
	if (node.type === "QUOTE_DOUBLE") return '"';
	return node.type === "QUOTE_SINGLE" ? "'" : "";
}

/**
 * Where a ready job's `runs-on` value is in the file. Refused when the value,
 * the job or the whole `jobs:` mapping is one that a YAML anchor shares with
 * other places: the edit would then change more than the job that was
 * selected. A `runs-on` that is itself an alias is safe, because only the
 * alias is replaced.
 */
function locateRunsOn(
	workflow: Workflow,
	entry: Node,
	job: YAMLMap,
	was: string,
): Rewrite {
	const source = workflow.source;
	if (workflow.jobsShared || isAlias(entry) || isAnchored(job)) {
		return refuse(SHARED_THROUGH_ANCHOR);
	}
	const pair = pairOf(job, "runs-on");
	const key = pair?.key;
	const value = pair?.value;
	if (!isScalar(key) || !isNode(value)) return refuse(NOT_LOCATED);
	const item = isSeq(value) ? value.items[0] : undefined;
	if (isAnchored(value) || (isNode(item) && isAnchored(item))) {
		return refuse(SHARED_THROUGH_ANCHOR);
	}
	const valueRange = value.range;
	if (!valueRange) return refuse(NOT_LOCATED);
	const whole: readonly [number, number] = [valueRange[0], valueRange[1]];
	if (!isSeq(value)) return spliceOver(source, whole, "", quoteOf(value), was);
	const itemRange = isNode(item) ? item.range : undefined;
	const keyRange = key.range;
	if (!isNode(item) || !itemRange || !keyRange) return refuse(NOT_LOCATED);
	if (value.flow !== true) {
		return blockListRewrite(source, keyRange, valueRange, itemRange, was);
	}
	// A flow list becomes the bare label. One with a comment inside keeps its
	// brackets, and so the comment: only the label in it changes.
	if (!source.slice(whole[0], whole[1]).includes("#")) {
		return spliceOver(source, whole, "", "", was);
	}
	return spliceOver(
		source,
		[itemRange[0], itemRange[1]],
		"",
		quoteOf(item),
		was,
	);
}

function inspectJob(
	workflow: Workflow,
	id: string,
	entry: Node | undefined,
): InspectedJob {
	const job = follow(workflow.doc, entry);
	if (entry === undefined || !isMap(job)) {
		const reason = "no_runs_on";
		return {
			plan: {
				file: workflow.file,
				job: id,
				name: undefined,
				verdict: "skipped",
				runsOn: "",
				reason,
				warnings: [],
			},
			rewrite: refuse(`skipped: ${describeWorkflowSkip(reason)}`),
		};
	}
	const runsOn = readRunsOn(workflow, job);
	const standing = standingOf(workflow, job, runsOn);
	const label = runsOn.label ?? "";
	const plan: WorkflowJobPlan = {
		file: workflow.file,
		job: id,
		name: stringOf(valueUnder(workflow, job, "name")),
		verdict: standing.verdict,
		runsOn: runsOn.text,
		reason: standing.reason,
		warnings:
			standing.verdict === "ready" ? warningsOf(workflow, job, label) : [],
	};
	if (standing.verdict === "routed") {
		return { plan, rewrite: refuse(ALREADY_ROUTED) };
	}
	if (standing.reason !== undefined) {
		return {
			plan,
			rewrite: refuse(`skipped: ${describeWorkflowSkip(standing.reason)}`),
		};
	}
	return { plan, rewrite: locateRunsOn(workflow, entry, job, label) };
}

function readWorkflow(
	file: string,
	source: string,
	settings: WorkflowInitOptions,
): WorkflowReading {
	const doc = parseDocument(source);
	const failure = doc.errors[0];
	if (failure !== undefined) {
		// The parser's message is a first line saying what and where, then an
		// excerpt of the file.
		const [summary = "it could not be parsed"] = failure.message.split("\n");
		return {
			error: `The file is not valid YAML: ${summary.replace(/[:.\s]+$/u, "")}.`,
			jobs: [],
		};
	}
	const root = doc.contents;
	const writtenJobs = isMap(root) ? writtenUnder(root, "jobs") : undefined;
	const jobs = follow(doc, writtenJobs);
	if (!isMap(root) || !isMap(jobs)) {
		return { error: "The file has no `jobs:` mapping.", jobs: [] };
	}
	const workflow: Workflow = {
		file,
		source,
		doc,
		root,
		jobsShared: isAlias(writtenJobs) || isAnchored(jobs),
		settings,
	};
	const inspected = jobs.items.flatMap((pair) => {
		const id = isScalar(pair.key) ? pair.key.source : undefined;
		if (id === undefined) return [];
		return [
			inspectJob(workflow, id, isNode(pair.value) ? pair.value : undefined),
		];
	});
	return {
		error: undefined,
		jobs: inspected.map((job) =>
			job.plan.verdict === "ready" && routesJobs(job.plan.job, inspected)
				? asRouter(job)
				: job,
		),
	};
}

/**
 * Whether another job takes its `runs-on` from this job's outputs. Such a job
 * decides where the others run, so it has to start even when the fleet is
 * down or full: it stays on the runner it has.
 */
function routesJobs(id: string, jobs: readonly InspectedJob[]): boolean {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const reference = new RegExp(
		`\\bneeds\\s*(?:\\.\\s*${escaped}(?![\\w-])|\\[\\s*(['"])${escaped}\\1\\s*\\])`,
		"iu",
	);
	return jobs.some(
		(other) => other.plan.job !== id && reference.test(other.plan.runsOn),
	);
}

function asRouter(job: InspectedJob): InspectedJob {
	const reason = "routes_jobs";
	return {
		plan: { ...job.plan, verdict: "skipped", reason, warnings: [] },
		rewrite: refuse(`skipped: ${describeWorkflowSkip(reason)}`),
	};
}

/**
 * Every job in one workflow file with its verdict. `file` is only reported
 * back; `source` is the file's text.
 */
export function planWorkflow(
	file: string,
	source: string,
	options?: Partial<WorkflowInitOptions>,
): WorkflowPlan {
	const reading = readWorkflow(file, source, settingsOf(options));
	return {
		file,
		jobs: reading.jobs.map((job) => job.plan),
		error: reading.error,
	};
}

/** The label as YAML that reads back as that string, in the quotes it replaces when it can keep them. */
function labelText(label: string, quote: string): string {
	const plain =
		PLAIN_LABEL.test(label) && !YAML_KEYWORDS.has(label.toLowerCase());
	return plain ? `${quote}${label}${quote}` : JSON.stringify(label);
}

/**
 * The text that takes a splice's place: the new label, then what was there as
 * a comment when nothing else follows on the line. A line that already ends
 * in a comment keeps it and gets no second one, and a value followed by more
 * of a flow mapping gets none either, since a comment there would swallow it.
 */
function replacementFor(
	source: string,
	rewrite: Extract<Rewrite, { kind: "splice" }>,
	fleetLabel: string,
): string {
	const lineBreak = source.indexOf("\n", rewrite.end);
	const rest = source.slice(
		rewrite.end,
		lineBreak === -1 ? source.length : lineBreak,
	);
	const note = rest.trim().length === 0 ? ` # was ${rewrite.was}` : "";
	return `${rewrite.lead}${labelText(fleetLabel, rewrite.quote)}${note}`;
}

/**
 * Rewrites the chosen jobs' `runs-on` to the fleet label. `jobs` are job ids;
 * the literal `all` selects every ready job. Only a ready job is rewritten.
 * A named job that is routed, skipped or missing is listed in `refused`, and
 * so is a ready job whose `runs-on` cannot be changed alone. Applying the
 * result again changes nothing.
 */
export function applyWorkflowPlan(
	file: string,
	source: string,
	jobs: readonly string[],
	options?: Partial<WorkflowInitOptions>,
): WorkflowApplyResult {
	const settings = settingsOf(options);
	const reading = readWorkflow(file, source, settings);
	const selected = [...new Set(jobs)];
	const failure = reading.error;
	if (failure !== undefined) {
		return {
			source,
			changed: [],
			refused: selected.map((job) => ({ job, why: failure })),
		};
	}
	const everyReady = selected.includes(EVERY_READY_JOB);
	const named = selected.filter((job) => job !== EVERY_READY_JOB);
	const known = new Map(reading.jobs.map((job) => [job.plan.job, job]));
	const chosen = reading.jobs.filter(
		(job) =>
			named.includes(job.plan.job) ||
			(everyReady && job.plan.verdict === "ready"),
	);
	const refused = [
		...named.flatMap((job) =>
			known.has(job) ? [] : [{ job, why: NO_SUCH_JOB }],
		),
		...chosen.flatMap((job) =>
			job.rewrite.kind === "refuse"
				? [{ job: job.plan.job, why: job.rewrite.why }]
				: [],
		),
	];
	const splices = chosen.flatMap((job) =>
		job.rewrite.kind === "splice"
			? [{ job: job.plan.job, rewrite: job.rewrite }]
			: [],
	);
	if (splices.length === 0) return { source, changed: [], refused };
	// From the end of the file backwards, so an earlier offset is still right
	// after a later value has changed length.
	const rewritten = [...splices]
		.sort((left, right) => right.rewrite.start - left.rewrite.start)
		.reduce(
			(text, { rewrite }) =>
				text.slice(0, rewrite.start) +
				replacementFor(source, rewrite, settings.fleetLabel) +
				text.slice(rewrite.end),
			source,
		);
	const changed = splices.map((splice) => splice.job);
	// Nothing known gets here. A file that no longer reads back with every
	// rewritten job on the fleet is not handed to the caller to write.
	const routed = new Set(
		readWorkflow(file, rewritten, settings)
			.jobs.filter((job) => job.plan.verdict === "routed")
			.map((job) => job.plan.job),
	);
	if (!changed.every((job) => routed.has(job))) {
		return {
			source,
			changed: [],
			refused: [
				...refused,
				...changed.map((job) => ({ job, why: WOULD_NOT_READ_BACK })),
			],
		};
	}
	return { source: rewritten, changed, refused };
}

/** Why a job is left as it is, as one sentence for a table. */
export function describeWorkflowSkip(reason: WorkflowSkipReason): string {
	switch (reason) {
		case "reusable_workflow":
			return "The job calls another workflow with `uses:`, so it has no `runs-on` of its own to change.";
		case "expression":
			return "Its `runs-on` is worked out while the workflow runs (a matrix value, an input, another job's output), so there is no fixed label to replace.";
		case "label_group":
			return "Its `runs-on` names a runner group or several labels, and the fleet answers to one label.";
		case "not_linux_x64":
			return "The job asks for Windows, macOS or an ARM machine, and the fleet runs Linux on x64.";
		case "provider_label":
			return "The job already runs on another hosted runner provider's label.";
		case "self_hosted":
			return "The job runs on a self-hosted runner or on a label nothing recognises, so what machine it expects is not known.";
		case "uses_secrets":
			return "The job looks like a deploy (an environment, write-all or id-token permissions, or a secret other than GITHUB_TOKEN) and stays where its secrets already are unless such jobs are asked for.";
		case "routes_jobs":
			return "Another job takes its `runs-on` from this job's outputs, so it decides where the others run and has to start even when the fleet cannot.";
		case "no_runs_on":
			return "The job has neither `runs-on` nor `uses:`, so there is nothing to change.";
	}
}

/** What to check before moving a ready job, as one sentence for a table. */
export function describeWorkflowWarning(warning: WorkflowWarning): string {
	switch (warning) {
		case "needs_docker":
			return "The job starts a service, runs in a container or uses a Docker action, so the fleet machine has to offer Docker.";
		case "installs_packages":
			return "A step installs system packages or runs sudo, which works only if the fleet image allows it.";
		case "moving_image":
			return "The job follows ubuntu-latest, which GitHub moves; the fleet image is pinned and may not match it.";
		case "matrix":
			return "The job has a matrix, so every leg of it will ask the fleet for a machine.";
	}
}
