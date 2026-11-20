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
	job: string;
	name: string | undefined;
	verdict: "ready" | "routed" | "skipped";
	runsOn: string;
	reason: WorkflowSkipReason | undefined;
	warnings: readonly WorkflowWarning[];
}>;

export type WorkflowPlan = Readonly<{
	file: string;
	jobs: readonly WorkflowJobPlan[];
	error: string | undefined;
}>;

export type WorkflowInitOptions = Readonly<{
	fleetLabel: string;
	includeSecretJobs: boolean;
}>;

export type WorkflowApplyResult = Readonly<{
	source: string;
	changed: readonly string[];
	refused: readonly Readonly<{ job: string; why: string }>[];
}>;

const EVERY_READY_JOB = "all";

const EXPRESSION_OPEN = "${{";

const SECRET_REFERENCE =
	/\bsecrets\b\s*(?:(?:\.\s*(?:\*(?![A-Za-z0-9_])|([A-Za-z_][A-Za-z0-9_-]*)(?![\w.-]|[\s]*\[))|\[\s*(?:\*(?![A-Za-z0-9_])|(['"])([A-Za-z_][A-Za-z0-9_-]*)\2\s*\](?![\s]*(?:\.|\[)))|\[))?/giu;

const PACKAGE_INSTALL = /\b(apt-get|apt|yum|dnf|apk)\s+(-\S+\s+)*install\b/u;

const SUDO = /\bsudo\b/u;

const PLAIN_LABEL = /^[A-Za-z][A-Za-z0-9._-]*$/u;

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
	"rewriting it would not leave the selected jobs routed and every unselected job unchanged; change it by hand";

type Value = Scalar | YAMLMap | YAMLSeq;

type Workflow = Readonly<{
	file: string;
	source: string;
	doc: Document;
	root: YAMLMap;
	jobsShared: boolean;
	settings: WorkflowInitOptions;
}>;

type RunsOn = Readonly<{
	form: "absent" | "mapping" | "labels";
	labels: readonly string[];
	label: string | undefined;
	text: string;
}>;

type Standing = Readonly<{
	verdict: WorkflowJobPlan["verdict"];
	reason: WorkflowSkipReason | undefined;
}>;

type Rewrite =
	| Readonly<{
			kind: "splice";
			start: number;
			end: number;
			lead: string;
			quote: string;
			was: string;
	  }>
	| Readonly<{ kind: "refuse"; why: string }>;

type InspectedJob = Readonly<{
	plan: WorkflowJobPlan;
	rewrite: Rewrite;
	indirectRouting: string;
	routingFields: string;
}>;

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

function follow(doc: Document, node: Node | undefined): Value | undefined {
	return isAlias(node) ? node.resolve(doc) : node;
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

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

function mergeSources(workflow: Workflow, map: YAMLMap): readonly YAMLMap[] {
	const merged = follow(workflow.doc, writtenUnder(map, "<<"));
	if (isMap(merged)) return [merged];
	if (!isSeq(merged)) return [];
	return merged.items.flatMap((item) => {
		const source = follow(workflow.doc, isNode(item) ? item : undefined);
		return isMap(source) ? [source] : [];
	});
}

function effectivePairs(
	workflow: Workflow,
	map: YAMLMap,
	seen = new Set<YAMLMap>(),
): readonly Pair[] {
	if (seen.has(map)) return [];
	seen.add(map);
	const inherited = mergeSources(workflow, map).flatMap((source) =>
		effectivePairs(workflow, source, seen),
	);
	const pairs: Pair[] = [];
	const keys = new Set<unknown>();
	for (const pair of [...map.items, ...inherited]) {
		if (isScalar(pair.key)) {
			if (pair.key.value === "<<" || keys.has(pair.key.value)) continue;
			keys.add(pair.key.value);
		}
		pairs.push(pair);
	}
	return pairs;
}

function effectivePairOf(
	workflow: Workflow,
	map: YAMLMap,
	key: string,
): Pair | undefined {
	return effectivePairs(workflow, map).find(
		(pair) => isScalar(pair.key) && pair.key.value === key,
	);
}

function effectiveWrittenUnder(
	workflow: Workflow,
	map: YAMLMap,
	key: string,
): Node | undefined {
	const value = effectivePairOf(workflow, map, key)?.value;
	return isNode(value) ? value : undefined;
}

function effectiveValueUnder(
	workflow: Workflow,
	map: YAMLMap,
	key: string,
): Value | undefined {
	return follow(workflow.doc, effectiveWrittenUnder(workflow, map, key));
}

function stringOf(node: Node | undefined): string | undefined {
	if (!isScalar(node)) return undefined;
	if (node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL") {
		return node.source?.trim().length ? node.source : String(node.value ?? "");
	}
	return node.value === node.source ? node.source : undefined;
}

function sliceOf(source: string, node: Node): string {
	const range = node.range;
	return range ? source.slice(range[0], range[1]) : "";
}

function onOneLine(source: string, node: Node): string {
	return sliceOf(source, node).trim().replace(/\s+/gu, " ");
}

function reachableText(workflow: Workflow, from: Node): readonly string[] {
	const seen = new Set<Node>();
	const pending: Node[] = [from];
	const texts: string[] = [];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		const subject = follow(workflow.doc, node);
		if (!isNode(subject)) continue;
		if (seen.has(subject)) continue;
		seen.add(subject);
		texts.push(sliceOf(workflow.source, subject));
		visit(subject, {
			Alias: (_key, alias) => {
				const target = alias.resolve(workflow.doc);
				if (target !== undefined) pending.push(target);
			},
		});
	}
	return texts;
}

function namesSecret(text: string): boolean {
	const reference = new RegExp(SECRET_REFERENCE.source, SECRET_REFERENCE.flags);
	return [...text.matchAll(reference)].some(
		(match) => (match[1] ?? match[3])?.toUpperCase() !== "GITHUB_TOKEN",
	);
}

function grantsDeployPermissions(workflow: Workflow, holder: YAMLMap): boolean {
	const permissions = effectiveValueUnder(workflow, holder, "permissions");
	if (stringOf(permissions) === "write-all") return true;
	return (
		isMap(permissions) &&
		effectivePairs(workflow, permissions).some(
			(pair) =>
				stringOf(
					follow(workflow.doc, isNode(pair.value) ? pair.value : undefined),
				) === "write",
		)
	);
}

function isDeployLike(workflow: Workflow, job: YAMLMap): boolean {
	if (effectivePairOf(workflow, job, "environment") !== undefined) return true;
	if (stringOf(effectiveValueUnder(workflow, job, "secrets")) === "inherit")
		return true;
	const permissionsHolder =
		effectivePairOf(workflow, job, "permissions") !== undefined
			? job
			: workflow.root;
	if (grantsDeployPermissions(workflow, permissionsHolder)) return true;
	const workflowEnv = effectiveWrittenUnder(workflow, workflow.root, "env");
	return [
		...reachableText(workflow, job),
		...(workflowEnv === undefined ? [] : reachableText(workflow, workflowEnv)),
	].some(namesSecret);
}

function needsJobId(node: Node | undefined): string | undefined {
	if (!isScalar(node)) return undefined;
	const source = node.source?.trim();
	if (source !== undefined && source.length > 0) return source;
	if (node.type === "QUOTE_SINGLE" || node.type === "QUOTE_DOUBLE") {
		const quoted = String(node.value ?? "").trim();
		return quoted.length > 0 ? quoted : undefined;
	}
	return undefined;
}

type NeedsRead = Readonly<{
	ids: readonly string[];
	opaque: boolean;
	present: boolean;
}>;

const EMPTY_NEEDS: NeedsRead = { ids: [], opaque: false, present: false };

const DOT_JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function caseFoldEscaped(escaped: string): string {
	return escaped.replace(/[A-Za-z]/gu, (letter) => {
		const lower = letter.toLowerCase();
		const upper = letter.toUpperCase();
		return `[${lower}${upper}]`;
	});
}

function caseFoldLiteral(value: string): string {
	return caseFoldEscaped(escapeRegExp(value));
}

const MATRIX_CONTEXT = new RegExp(
	String.raw`\b${caseFoldLiteral("matrix")}\b`,
	"u",
);

function expressionDouble(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function quoteAlternatives(value: string): string {
	const expressionSingle = `'${caseFoldEscaped(escapeRegExp(value.replaceAll("'", "''")))}'`;
	const expressionDoubleQuoted = `"${caseFoldEscaped(escapeRegExp(expressionDouble(value)))}"`;
	const yamlDoubledSingle = caseFoldEscaped(
		escapeRegExp(`'${value.replaceAll("'", "''")}'`.replaceAll("'", "''")),
	);
	const yamlEscapedDouble = caseFoldEscaped(
		escapeRegExp(
			`"${expressionDouble(value)}"`
				.replaceAll("\\", "\\\\")
				.replaceAll('"', '\\"'),
		),
	);
	return [
		expressionSingle,
		expressionDoubleQuoted,
		yamlDoubledSingle,
		yamlEscapedDouble,
	].join("|");
}

function patternMatches(pattern: string, text: string): boolean {
	try {
		return new RegExp(pattern, "u").test(text);
	} catch {
		return false;
	}
}

function propertyAccessPattern(name: string): string {
	return String.raw`(?:\.\s*${caseFoldLiteral(name)}\b|\[\s*(?:${quoteAlternatives(name)})\s*\])`;
}

function outputsAccessPattern(): string {
	return propertyAccessPattern("outputs");
}

function routingAccessPattern(): string {
	return `(?:${propertyAccessPattern("outputs")}|${propertyAccessPattern("result")})`;
}

function needsJobReferencePattern(jobId: string): string {
	const index = String.raw`\[\s*(?:${quoteAlternatives(jobId)})\s*\]`;
	const nestedIndex = String.raw`(?:${index})+`;
	const dot = DOT_JOB_ID.test(jobId)
		? String.raw`\.\s*${caseFoldLiteral(jobId)}(?![\w-])|`
		: "";
	return String.raw`\b${caseFoldLiteral("needs")}(?:\s*\))*\s*(?:${dot}(?:${index}|${nestedIndex})|${nestedIndex})`;
}

function needsWildcardPattern(): string {
	const index = String.raw`\[\s*(?:${quoteAlternatives("*")}|\*)\s*\]`;
	return String.raw`\b${caseFoldLiteral("needs")}(?:\s*\))*\s*(?:\.\s*\*|${index})`;
}

function staticNeedsIndex(): string {
	const expressionSingle = `'(?:[^']|'')*'`;
	const yamlDoubledSingle = `''(?:[^']|'')*''`;
	const expressionDouble = String.raw`"(?:[^"\\]|\\.)*"`;
	const yamlEscapedDouble = String.raw`\\"(?:[^"\\]|\\.)*\\"`;
	return String.raw`(?:\*|${yamlDoubledSingle}|${expressionSingle}|${expressionDouble}|${yamlEscapedDouble})`;
}

const DYNAMIC_NEEDS_INDEX = String.raw`\b${caseFoldLiteral("needs")}(?:\s*\))*\s*\[(?!\s*${staticNeedsIndex()}\s*\])`;

function classifyNeedsItem(
	workflow: Workflow,
	node: Node | undefined,
): "blank" | "opaque" | string {
	if (node === undefined) return "blank";
	const resolved = follow(workflow.doc, node);
	if (!isScalar(resolved)) return "opaque";
	const id = needsJobId(resolved);
	if (id === undefined) return "blank";
	if (id.includes(EXPRESSION_OPEN)) return "opaque";
	return id;
}

function readNeeds(workflow: Workflow, job: YAMLMap): NeedsRead {
	const needs = effectiveValueUnder(workflow, job, "needs");
	if (needs === undefined) return EMPTY_NEEDS;
	const items = isScalar(needs)
		? [classifyNeedsItem(workflow, needs)]
		: isSeq(needs)
			? needs.items.map((item) =>
					classifyNeedsItem(workflow, isNode(item) ? item : undefined),
				)
			: ["opaque" as const];
	return {
		present: true,
		opaque: items.some((item) => item === "opaque"),
		ids: items.filter(
			(item): item is string => item !== "blank" && item !== "opaque",
		),
	};
}

function sameJobId(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function needsCanSee(needs: NeedsRead, jobId: string): boolean {
	if (!needs.present || needs.opaque) return needs.present;
	return needs.ids.some((id) => sameJobId(id, jobId));
}

function toJsonCallPattern(argument: string): string {
	return (
		String.raw`\b${caseFoldLiteral("toJSON")}\s*\(\s*(?:\(\s*)*` +
		argument +
		String.raw`\s*(?:\)\s*)*\)`
	);
}

function groupedNeeds(reference: string): string {
	return String.raw`(?:\(\s*)*${reference}\s*(?:\)\s*)*`;
}

function jobPropertyPattern(access: string): string {
	const starFilter = String.raw`(?:\.\s*\*|\[\s*(?:${quoteAlternatives("*")}|\*)\s*\])`;
	const nonLiteralIndex = String.raw`\[(?!\s*${staticNeedsIndex()}\s*\])[\s\S]*?\]`;
	const nestedNonLiteralIndex = String.raw`(?:${nonLiteralIndex})+`;
	return `(?:${access}|${starFilter}|${nonLiteralIndex}|${nestedNonLiteralIndex})`;
}

function referencesNeedsAccess(
	text: string,
	jobId: string,
	needs: NeedsRead,
	access: string,
	strictOpen = false,
): boolean {
	const jobReference = needsJobReferencePattern(jobId);
	if (
		patternMatches(
			`${groupedNeeds(jobReference)}\\s*${jobPropertyPattern(access)}`,
			text,
		)
	) {
		return true;
	}
	if (patternMatches(toJsonCallPattern(jobReference), text)) return true;
	if (
		patternMatches(
			String.raw`\bfromJSON\s*\(\s*${groupedNeeds(jobReference)}(?:\\s*${jobPropertyPattern(access)}|[^)]*)\\s*\\)`,
			text,
		)
	) {
		return true;
	}
	const property = `\\s*${jobPropertyPattern(access)}`;
	const bareNeedsJson =
		patternMatches(toJsonCallPattern(caseFoldLiteral("needs")), text) ||
		patternMatches(toJsonCallPattern(needsWildcardPattern()), text);
	if (bareNeedsJson && needsCanSee(needs, jobId)) {
		if (!strictOpen) return true;
		if (needs.opaque) return true;
		if (needs.ids.some((id) => sameJobId(id, jobId))) return true;
	}
	const open =
		patternMatches(
			`${groupedNeeds(needsWildcardPattern())}${property}`,
			text,
		) ||
		(strictOpen
			? patternMatches(
					`${toJsonCallPattern(caseFoldLiteral("needs"))}${property}`,
					text,
				) ||
				patternMatches(
					`${toJsonCallPattern(needsWildcardPattern())}${property}`,
					text,
				)
			: false);
	if (open && needsCanSee(needs, jobId)) return true;
	const dynamicIndex = `${DYNAMIC_NEEDS_INDEX}[\\s\\S]*?\\]`;
	if (patternMatches(`${groupedNeeds(dynamicIndex)}${property}`, text)) {
		return true;
	}
	return patternMatches(toJsonCallPattern(dynamicIndex), text);
}

function referencesNeedsOutputs(
	text: string,
	jobId: string,
	needs: NeedsRead,
): boolean {
	return referencesNeedsAccess(text, jobId, needs, outputsAccessPattern());
}

type WorkflowJobEntry = Readonly<{ id: string; job: YAMLMap }>;

function computeSecretJobIds(
	workflow: Workflow,
	entries: readonly WorkflowJobEntry[],
	needsByJob: ReadonlyMap<string, NeedsRead>,
): ReadonlySet<string> {
	const secret = new Set<string>();
	for (const { id, job } of entries) {
		if (isDeployLike(workflow, job)) secret.add(id);
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const { id, job } of entries) {
			if (secret.has(id)) continue;
			const needs = needsByJob.get(id) ?? EMPTY_NEEDS;
			if (needs.present && needs.opaque && secret.size > 0) {
				secret.add(id);
				grew = true;
				continue;
			}
			if (
				needs.ids.some((need) =>
					[...secret].some((secretId) => sameJobId(secretId, need)),
				)
			) {
				secret.add(id);
				grew = true;
				continue;
			}
			const text = reachableText(workflow, job).join("\n");
			if (
				[...secret].some((upstream) =>
					referencesNeedsOutputs(text, upstream, needs),
				)
			) {
				secret.add(id);
				grew = true;
			}
		}
	}
	return secret;
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

function labelStanding(label: string, settings: WorkflowInitOptions): Standing {
	const lower = label.toLowerCase();
	if (
		FLEET_RUNNER_LABELS.some((fleet) => fleet === lower) ||
		lower === settings.fleetLabel.toLowerCase()
	) {
		return ROUTED;
	}

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

function standingOf(
	workflow: Workflow,
	job: YAMLMap,
	runsOn: RunsOn,
	usesSecrets: boolean,
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
	if (!workflow.settings.includeSecretJobs && usesSecrets) {
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

function isAnchored(node: Node): boolean {
	return !isAlias(node) && node.anchor !== undefined;
}

function columnOf(source: string, offset: number): number {
	return offset - (source.lastIndexOf("\n", offset - 1) + 1);
}

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

	const lead =
		columnOf(source, dash) > columnOf(source, keyRange[0]) ? "" : " ";
	return spliceOver(source, [dash, itemRange[1]], lead, "", was);
}

function quoteOf(node: Node): string {
	if (!isScalar(node)) return "";
	if (node.type === "QUOTE_DOUBLE") return '"';
	return node.type === "QUOTE_SINGLE" ? "'" : "";
}

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

const ROUTING_FIELD_KEYS = ["env", "if", "container", "services"] as const;

function stepRoutingText(workflow: Workflow, job: YAMLMap): string {
	const parts: string[] = [];
	for (const step of stepsOf(workflow, job)) {
		const runsOn = effectiveValueUnder(workflow, step, "runs-on");
		if (runsOn !== undefined && isNode(runsOn)) {
			parts.push(...reachableText(workflow, runsOn));
		}
	}
	return parts.join("\n");
}

function routingFieldsOf(workflow: Workflow, job: YAMLMap): string {
	const parts: string[] = [];
	for (const key of ROUTING_FIELD_KEYS) {
		const node = effectiveValueUnder(workflow, job, key);
		if (node === undefined || !isNode(node)) continue;
		parts.push(...reachableText(workflow, node));
	}
	parts.push(stepRoutingText(workflow, job));
	return parts.join("\n");
}

function indirectRoutingOf(
	workflow: Workflow,
	job: YAMLMap,
	runsOn: RunsOn,
): string {
	const key =
		effectivePairOf(workflow, job, "uses") !== undefined
			? "with"
			: runsOn.text.includes(EXPRESSION_OPEN) &&
					MATRIX_CONTEXT.test(runsOn.text)
				? "strategy"
				: undefined;
	if (key === undefined) return "";
	const node = effectiveWrittenUnder(workflow, job, key);
	return node === undefined ? "" : reachableText(workflow, node).join("\n");
}

function inspectJob(
	workflow: Workflow,
	id: string,
	entry: Node | undefined,
	usesSecrets: boolean,
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
			indirectRouting: "",
			routingFields: "",
		};
	}
	const runsOn = readRunsOn(workflow, job);
	const standing = standingOf(workflow, job, runsOn, usesSecrets);
	const label = runsOn.label ?? "";
	const indirectRouting = indirectRoutingOf(workflow, job, runsOn);
	const routingFields = routingFieldsOf(workflow, job);
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
		return {
			plan,
			rewrite: refuse(ALREADY_ROUTED),
			indirectRouting,
			routingFields,
		};
	}
	if (standing.reason !== undefined) {
		return {
			plan,
			rewrite: refuse(`skipped: ${describeWorkflowSkip(standing.reason)}`),
			indirectRouting,
			routingFields,
		};
	}
	return {
		plan,
		rewrite: locateRunsOn(workflow, entry, job, label),
		indirectRouting,
		routingFields,
	};
}

function readWorkflow(
	file: string,
	source: string,
	settings: WorkflowInitOptions,
): WorkflowReading {
	const doc = parseDocument(source);
	const failure = doc.errors[0];
	if (failure !== undefined) {
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
	const entries = jobs.items.flatMap((pair) => {
		const id = isScalar(pair.key) ? pair.key.source : undefined;
		if (id === undefined) return [];
		const entry = isNode(pair.value) ? pair.value : undefined;
		const job = follow(workflow.doc, entry);
		if (!isMap(job)) return [];
		return [{ id, job }] satisfies WorkflowJobEntry[];
	});
	const needsByJob = new Map(
		entries.map(({ id, job }) => [id, readNeeds(workflow, job)]),
	);
	const secretJobIds = computeSecretJobIds(workflow, entries, needsByJob);
	const inspected = jobs.items.flatMap((pair) => {
		const id = isScalar(pair.key) ? pair.key.source : undefined;
		if (id === undefined) return [];
		return [
			inspectJob(
				workflow,
				id,
				isNode(pair.value) ? pair.value : undefined,
				secretJobIds.has(id),
			),
		];
	});
	const routed = inspected.map((job) =>
		routesJobs(job.plan.job, inspected, needsByJob) ? asRouter(job) : job,
	);
	return { error: undefined, jobs: routed };
}

function routingText(job: InspectedJob): string {
	return `${job.plan.runsOn}\n${job.indirectRouting}\n${job.routingFields}`;
}

function referencesRoutedJob(
	text: string,
	jobId: string,
	needs: NeedsRead,
): boolean {
	return referencesNeedsAccess(
		text,
		jobId,
		needs,
		routingAccessPattern(),
		true,
	);
}

function routesJobs(
	id: string,
	jobs: readonly InspectedJob[],
	needsByJob: ReadonlyMap<string, NeedsRead>,
): boolean {
	return jobs.some((other) => {
		if (other.plan.job === id) return false;
		const needs = needsByJob.get(other.plan.job) ?? EMPTY_NEEDS;
		return referencesRoutedJob(routingText(other), id, needs);
	});
}

function asRouter(job: InspectedJob): InspectedJob {
	const reason = "routes_jobs";
	return {
		...job,
		plan: { ...job.plan, verdict: "skipped", reason, warnings: [] },
		rewrite: refuse(`skipped: ${describeWorkflowSkip(reason)}`),
	};
}

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

function labelText(label: string, quote: string): string {
	const plain =
		PLAIN_LABEL.test(label) && !YAML_KEYWORDS.has(label.toLowerCase());
	return plain ? `${quote}${label}${quote}` : JSON.stringify(label);
}

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
	const changedSet = new Set(changed);
	const unselectedPlans = (jobs: readonly InspectedJob[]) =>
		jobs.filter((job) => !changedSet.has(job.plan.job)).map((job) => job.plan);
	const after = readWorkflow(file, rewritten, settings);
	const routed = new Set(
		after.jobs
			.filter((job) => job.plan.verdict === "routed")
			.map((job) => job.plan.job),
	);
	const preservesUnselected =
		JSON.stringify(unselectedPlans(reading.jobs)) ===
		JSON.stringify(unselectedPlans(after.jobs));
	if (!changed.every((job) => routed.has(job)) || !preservesUnselected) {
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
			return "The job looks like a deploy (an environment, write permissions, or a secret other than GITHUB_TOKEN) and stays where its secrets already are unless such jobs are asked for.";
		case "routes_jobs":
			return "Another job takes its `runs-on` from this job's outputs, so it decides where the others run and has to start even when the fleet cannot.";
		case "no_runs_on":
			return "The job has neither `runs-on` nor `uses:`, so there is nothing to change.";
	}
}

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
