/**
 * `hobo ci init --relay` and `--undo`: put a relay job in front of a
 * workflow's jobs, and take it out again (ADR-0183,
 * `docs/design/adr/runner-order.md`).
 *
 * A relay job asks which runner a job should use. For each job chosen, the
 * edit adds a job `relay-<job>` just above it that calls the repository's
 * `.github/workflows/hobo-relay.yml` with `github:` set to the label the job
 * had, adds the relay to the job's `needs`, and sets the job's `runs-on` to
 * the relay's `runner` output. A matrix job gets one relay for all its legs,
 * because the relay is a job of its own and every leg reads its output.
 *
 * The edit splices bytes into the file and never writes it back out from its
 * parsed form, so comments, quoting, indentation and line endings stay as
 * they were. Undoing it removes exactly what was added and puts the label
 * back from the relay's `github:` input. An edit that undoing would not
 * reverse byte for byte is refused before it is made, and a file changed
 * since in a way undoing cannot reverse is refused with the lines that
 * changed.
 *
 * The two files the relay job needs are generated
 * (`_generated-assets/relay-job-assets.ts`). `relayFilesFor` gives them for
 * a mode, and `checkRelayFiles` tells whether the copies in a repository are
 * the ones this build writes.
 *
 * Pure functions: no filesystem, clock or network. The caller reads the files
 * and writes the results.
 */
import { createHash } from "node:crypto";
import {
	RELAY_EVALUATOR_FILE,
	RELAY_JOB_INPUTS,
	RELAY_LABEL,
	RELAY_WORKFLOW_FILE,
	type RelayJobInputName,
} from "@hobo/ci";
import {
	isAlias,
	isMap,
	isNode,
	isScalar,
	isSeq,
	type Node,
	type Pair,
	parseDocument,
	type Scalar,
	type YAMLMap,
} from "yaml";
import {
	RELAY_JOB_EVALUATOR,
	RELAY_JOB_EVALUATOR_SHA256,
	RELAY_JOB_WORKFLOW,
	RELAY_JOB_WORKFLOW_SHA256,
} from "./_generated-assets/relay-job-assets.js";
import { planWorkflow, type WorkflowApplyResult } from "./workflow-init.js";

// public-contract: how `hobo ci init --relay` has relay jobs answered.
export const RELAY_INIT_MODES = ["job", "relay"] as const;
export type RelayInitMode = (typeof RELAY_INIT_MODES)[number];

// public-contract: what a relay job written by `hobo ci init --relay` calls.
export const RELAY_WORKFLOW_USES = `./${RELAY_WORKFLOW_FILE}`;

// public-contract: the id of the relay job written in front of a job.
export const RELAY_JOB_ID_PREFIX = "relay-";

export type RelayInputValue = Readonly<{
	name: RelayJobInputName;
	value: string;
}>;

export type WorkflowRelayOptions = Readonly<{
	/** Deploy-like jobs are ready instead of skipped as `uses_secrets`. */
	includeSecretJobs: boolean;
	/**
	 * Inputs every relay gets besides `github`, which is always the job's own
	 * label. An input named `github` here is ignored.
	 */
	inputs: readonly RelayInputValue[];
}>;

/** A relay job found in a workflow file. */
export type WorkflowRelay = Readonly<{
	/** The relay job's id. */
	relay: string;
	/** The job it routes: the relay's id without its prefix. */
	job: string;
	/** Its `github:` input: the label undoing gives the job back. */
	github: string | undefined;
}>;

export type WorkflowUndoResult = Readonly<{
	/** The new file text. The input text when nothing was undone. */
	source: string;
	/** Jobs given back their label, in file order. */
	restored: readonly string[];
	/** Relays left in place, each with why and the lines that stopped it. */
	refused: readonly Readonly<{
		job: string;
		why: string;
		/** The first and last line, counted from 1, that undoing could not reverse. */
		lines: readonly [number, number];
	}>[];
}>;

/** One generated file a relay job needs, as the repository should hold it. */
export type RelayFile = Readonly<{ path: string; text: string }>;

// public-contract: what a check finds for one generated relay file.
export const RELAY_FILE_STATES = [
	"current",
	"stale",
	"edited",
	"missing",
	"not_needed",
] as const;
export type RelayFileState = (typeof RELAY_FILE_STATES)[number];

export type RelayFileCheck = Readonly<{
	path: string;
	state: RelayFileState;
	/** One sentence for a person. */
	detail: string;
}>;

export type RelayFilesCheck = Readonly<{
	/** The mode the installed workflow is written for, when it is a known one. */
	mode: RelayInitMode | undefined;
	files: readonly RelayFileCheck[];
	/** Every file is current or not needed. */
	current: boolean;
}>;

/** Selects every job when given in place of a job id. */
const EVERY_JOB = "all";

const NO_SUCH_JOB = "no such job";

const NOT_READY = "it is not a job that can move behind a relay";

const SHARED_THROUGH_ANCHOR =
	"it is shared through a YAML anchor, so editing it would change more than this job; change it by hand";

const NOT_LOCATED =
	"its runs-on or needs could not be located as block YAML in the file; change it by hand";

const NOT_REVERSIBLE =
	"the edit could not be undone byte for byte later; change runs-on to one label first";

const WOULD_NOT_READ_BACK =
	"the rewritten file would not read back with every relay in place; change it by hand";

/** A value that reads back as the same string when written without quotes. */
const PLAIN_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.,-]*(?:[ ,][A-Za-z0-9_.,-]+)*$/u;

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

const HEADER_END = "// --- end of header ---\n";
const HEADER_SHA = /^\/\/ sha256: ([0-9a-f]{64})$/mu;
const WORKFLOW_HEAD = "# The HoBo relay job, job mode (ADR-0183).";
const RELAY_WORKFLOW_HEAD = "# The HoBo relay job, relay mode (ADR-0183).";
const JOB_MODE_RUNS_ON = "\n    runs-on: ubuntu-24.04\n";

/** One byte range replaced by new text. `rank` orders inserts at one offset. */
type Splice = Readonly<{
	start: number;
	end: number;
	text: string;
	rank: number;
}>;

type Refusal = Readonly<{ why: string; lines: readonly [number, number] }>;

/** What a check finds for the relay workflow, and the mode it is written for. */
type WorkflowFileCheck = Readonly<{
	mode: RelayInitMode | undefined;
	check: RelayFileCheck;
}>;

type Reading = Readonly<{
	source: string;
	/** The line ending the file uses. */
	eol: string;
	/** The `jobs:` mapping; undefined when `problem` says why there is none to edit. */
	jobs: YAMLMap | undefined;
	problem: string;
}>;

/** Where a job's single `runs-on` label is written. */
type RunsOnTarget = Readonly<{
	keyLineStart: number;
	/** The whitespace before the `runs-on` key. */
	keyIndent: string;
	scalar: Scalar;
	start: number;
	end: number;
	/** The scalar sits inside a `[...]` list. */
	inFlow: boolean;
}>;

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function lineStartOf(source: string, offset: number): number {
	return source.lastIndexOf("\n", offset - 1) + 1;
}

/** The offset just past the line break ending the line `offset` is on. */
function nextLineStart(source: string, offset: number): number {
	const lineBreak = source.indexOf("\n", offset);
	return lineBreak === -1 ? source.length : lineBreak + 1;
}

function lineNumberOf(source: string, offset: number): number {
	let count = 1;
	for (
		let at = source.indexOf("\n");
		at !== -1 && at < offset;
		at = source.indexOf("\n", at + 1)
	)
		count += 1;
	return count;
}

function linesOf(
	source: string,
	start: number,
	end: number,
): readonly [number, number] {
	const last = Math.max(start, end - 1);
	return [lineNumberOf(source, start), lineNumberOf(source, last)];
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function nodeUnder(map: YAMLMap, key: string): Node | undefined {
	const value = pairOf(map, key)?.value;
	return isNode(value) ? value : undefined;
}

function isAnchored(node: Node): boolean {
	return !isAlias(node) && node.anchor !== undefined;
}

/** A scalar's text when YAML read it as a string. */
function stringOf(node: Node | undefined): string | undefined {
	return isScalar(node) && node.value === node.source ? node.source : undefined;
}

/** A node's start and its end with trailing spaces cut. */
function spanOf(
	source: string,
	node: Node,
): readonly [number, number] | undefined {
	const range = node.range;
	if (!range) return undefined;
	const start = range[0];
	return [start, start + source.slice(start, range[1]).trimEnd().length];
}

function textOf(source: string, node: Node): string {
	const span = spanOf(source, node);
	return span ? source.slice(span[0], span[1]) : "";
}

function quoteOf(node: Scalar): string {
	if (node.type === "QUOTE_DOUBLE") return '"';
	return node.type === "QUOTE_SINGLE" ? "'" : "";
}

/** A value as YAML that reads back as that string. */
function yamlText(value: string): string {
	return PLAIN_VALUE.test(value) && !YAML_KEYWORDS.has(value.toLowerCase())
		? value
		: JSON.stringify(value);
}

/** A label in the quotes given, or in double quotes when it cannot go bare. */
function labelIn(label: string, quote: string): string {
	if (quote !== "") return `${quote}${label}${quote}`;
	return yamlText(label);
}

export function relayJobIdFor(job: string): string {
	return `${RELAY_JOB_ID_PREFIX}${job}`;
}

/** The `runs-on` a job behind its relay is given. */
export function relayRunnerExpression(relay: string): string {
	return `\${{ needs.${relay}.outputs.runner }}`;
}

function read(source: string): Reading {
	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	const doc = parseDocument(source);
	const none = (problem: string): Reading => ({
		source,
		eol,
		jobs: undefined,
		problem,
	});
	if (doc.errors.length > 0) return none("The file is not valid YAML.");
	const root = doc.contents;
	const jobs = isMap(root) ? nodeUnder(root, "jobs") : undefined;
	if (!isMap(jobs)) return none("The file has no `jobs:` mapping.");
	if (jobs.flow === true || isAnchored(jobs))
		return none(
			"Its `jobs:` mapping is written in flow style or shared through an anchor.",
		);
	return { source, eol, jobs, problem: "" };
}

/** A block mapping's key that starts its own line, and the whitespace before it. */
function ownLineKey(
	source: string,
	pair: Pair,
): Readonly<{ lineStart: number; indent: string; start: number }> | undefined {
	const key = pair.key;
	if (!isScalar(key) || !key.range) return undefined;
	const start = key.range[0];
	const lineStart = lineStartOf(source, start);
	const indent = source.slice(lineStart, start);
	return /^ *$/u.test(indent) ? { lineStart, indent, start } : undefined;
}

function runsOnTarget(
	source: string,
	job: YAMLMap,
	jobIndent: string,
): RunsOnTarget | undefined {
	const pair = pairOf(job, "runs-on");
	if (pair === undefined) return undefined;
	const key = ownLineKey(source, pair);
	if (
		key === undefined ||
		key.indent.length <= jobIndent.length ||
		!key.indent.startsWith(jobIndent)
	)
		return undefined;
	const value = isNode(pair.value) ? pair.value : undefined;
	if (value === undefined || isAlias(value) || isAnchored(value))
		return undefined;
	const only =
		isSeq(value) && value.items.length === 1 ? value.items[0] : value;
	if (!isScalar(only) || isAnchored(only)) return undefined;
	const span = spanOf(source, only);
	if (!span) return undefined;
	return {
		keyLineStart: key.lineStart,
		keyIndent: key.indent,
		scalar: only,
		start: span[0],
		end: span[1],
		inFlow: isSeq(value) && value.flow === true,
	};
}

/** The text of a relay job, from its indentation and its `with:` entries. */
function relayBlock(
	indent: string,
	step: string,
	relay: string,
	entries: readonly Readonly<{ name: string; text: string }>[],
	eol: string,
): string {
	const inner = `${indent}${step}`;
	return [
		`${indent}${relay}:`,
		`${inner}uses: ${RELAY_WORKFLOW_USES}`,
		`${inner}permissions:`,
		`${inner}${step}actions: read`,
		`${inner}${step}contents: read`,
		`${inner}with:`,
		...entries.map((entry) => `${inner}${step}${entry.name}: ${entry.text}`),
	]
		.map((line) => `${line}${eol}`)
		.join("");
}

/** The relay's `with:` entries: the job's label as `github`, then the rest in input order. */
function relayEntries(
	label: string,
	inputs: readonly RelayInputValue[],
): readonly Readonly<{ name: string; text: string }>[] {
	const given = new Map<string, string>(
		inputs.flatMap((input) =>
			input.name === "github" ? [] : [[input.name, input.value] as const],
		),
	);
	given.set("github", label);
	return RELAY_JOB_INPUTS.flatMap((name) => {
		const value = given.get(name);
		return value === undefined ? [] : [{ name, text: yamlText(value) }];
	});
}

/** The edit that adds the relay to `needs`. */
function needsSplice(
	reading: Reading,
	job: YAMLMap,
	relay: string,
	runsOn: RunsOnTarget,
	rank: number,
): Splice | undefined {
	const { source, eol } = reading;
	const pair = pairOf(job, "needs");
	if (pair === undefined)
		return {
			start: runsOn.keyLineStart,
			end: runsOn.keyLineStart,
			text: `${runsOn.keyIndent}needs: ${relay}${eol}`,
			rank,
		};
	const value = isNode(pair.value) ? pair.value : undefined;
	if (value === undefined || isAlias(value) || isAnchored(value))
		return undefined;
	if (isScalar(value)) {
		const span = spanOf(source, value);
		if (!span || stringOf(value) === undefined) return undefined;
		return {
			start: span[0],
			end: span[1],
			text: `[${relay}, ${source.slice(span[0], span[1])}]`,
			rank,
		};
	}
	if (!isSeq(value) || !value.items.every((item) => isScalar(item)))
		return undefined;
	const items = value.items.filter((item) => isScalar(item));
	const last = items[items.length - 1];
	const lastSpan = last === undefined ? undefined : spanOf(source, last);
	if (value.flow === true) {
		if (lastSpan === undefined) {
			const open = value.range?.[0];
			if (open === undefined || source[open] !== "[") return undefined;
			return { start: open + 1, end: open + 1, text: relay, rank };
		}
		return { start: lastSpan[1], end: lastSpan[1], text: `, ${relay}`, rank };
	}
	if (lastSpan === undefined) return undefined;
	const prefix = source.slice(lineStartOf(source, lastSpan[0]), lastSpan[0]);
	if (!/^ *- +$/u.test(prefix)) return undefined;
	const at = nextLineStart(source, lastSpan[1]);
	const atEnd = at === source.length && !source.endsWith("\n");
	return {
		start: at,
		end: at,
		text: atEnd ? `${eol}${prefix}${relay}` : `${prefix}${relay}${eol}`,
		rank,
	};
}

/** The three edits that put one job behind its relay, or why they cannot be made. */
function relaySplices(
	reading: Reading,
	jobs: YAMLMap,
	id: string,
	label: string,
	inputs: readonly RelayInputValue[],
	rank: number,
): Readonly<{ splices: readonly Splice[] }> | Readonly<{ why: string }> {
	const { source, eol } = reading;
	const refuse = (why: string) => ({ why });
	const pair = pairOf(jobs, id);
	const job = pair?.value;
	if (pair === undefined || !isNode(job)) return refuse(NO_SUCH_JOB);
	if (isAlias(job) || isAnchored(job)) return refuse(SHARED_THROUGH_ANCHOR);
	if (!isMap(job) || job.flow === true) return refuse(NOT_LOCATED);
	const relay = relayJobIdFor(id);
	if (pairOf(jobs, relay) !== undefined)
		return refuse(`a job named ${relay} already exists`);
	const key = ownLineKey(source, pair);
	if (key === undefined) return refuse(NOT_LOCATED);
	const runsOn = runsOnTarget(source, job, key.indent);
	if (runsOn === undefined) return refuse(NOT_LOCATED);
	const needs = needsSplice(reading, job, relay, runsOn, rank);
	if (needs === undefined) return refuse(NOT_LOCATED);
	const quote = quoteOf(runsOn.scalar) || (runsOn.inFlow ? '"' : "");
	const step = runsOn.keyIndent.slice(key.indent.length);
	const splices: readonly Splice[] = [
		{
			start: key.lineStart,
			end: key.lineStart,
			text: relayBlock(
				key.indent,
				step,
				relay,
				relayEntries(label, inputs),
				eol,
			),
			rank,
		},
		needs,
		{
			start: runsOn.start,
			end: runsOn.end,
			text: `${quote}${relayRunnerExpression(relay)}${quote}`,
			rank,
		},
	];
	return { splices };
}

/**
 * Applies splices from the end of the file backwards, so an earlier offset is
 * still right after a later one changed length. At one offset the splice of
 * the later job goes first, so the earlier job's text ends up before it.
 */
function applySplices(source: string, splices: readonly Splice[]): string {
	return [...splices]
		.sort((left, right) => right.start - left.start || right.rank - left.rank)
		.reduce(
			(text, splice) =>
				text.slice(0, splice.start) + splice.text + text.slice(splice.end),
			source,
		);
}

/** The edits that take one relay out, or the lines that stop it. */
function undoSplices(
	reading: Reading,
	jobs: YAMLMap,
	index: number,
): readonly Splice[] | Refusal {
	const { source, eol } = reading;
	const relayPair = jobs.items[index];
	const relayNode = relayPair?.value;
	if (relayPair === undefined || !isMap(relayNode))
		return { why: NOT_LOCATED, lines: [1, 1] };
	const relay =
		stringOf(isNode(relayPair.key) ? relayPair.key : undefined) ?? "";
	const relayKey = ownLineKey(source, relayPair);
	const relayLines = (end: number) =>
		linesOf(source, relayKey?.lineStart ?? 0, end);
	const jobPair = jobs.items[index + 1];
	const job = jobPair?.value;
	const id = relay.slice(RELAY_JOB_ID_PREFIX.length);
	const jobKey =
		jobPair === undefined ? undefined : ownLineKey(source, jobPair);
	if (
		relayKey === undefined ||
		jobPair === undefined ||
		jobKey === undefined ||
		!isScalar(jobPair.key) ||
		jobPair.key.value !== id ||
		!isMap(job)
	)
		return {
			why: `the job ${id} no longer follows its relay ${relay}`,
			lines: relayLines(nextLineStart(source, relayKey?.start ?? 0)),
		};
	const withMap = nodeUnder(relayNode, "with");
	const github = isMap(withMap)
		? stringOf(nodeUnder(withMap, "github"))
		: undefined;
	const usesPair = pairOf(relayNode, "uses");
	const usesKey = usesPair ? ownLineKey(source, usesPair) : undefined;
	const blockLines = relayLines(jobKey.lineStart);
	if (!isMap(withMap) || github === undefined || usesKey === undefined)
		return {
			why: `the relay ${relay} has no github input to give the job back`,
			lines: blockLines,
		};
	const entries = withMap.items.map((entry) => ({
		name: isNode(entry.key) ? textOf(source, entry.key) : "",
		text: isNode(entry.value) ? textOf(source, entry.value) : "",
	}));
	const expected = relayBlock(
		relayKey.indent,
		usesKey.indent.slice(relayKey.indent.length),
		relay,
		entries,
		eol,
	);
	if (source.slice(relayKey.lineStart, jobKey.lineStart) !== expected)
		return {
			why: `the relay ${relay} changed since hobo ci init wrote it`,
			lines: blockLines,
		};
	const runsOn = runsOnTarget(source, job, jobKey.indent);
	if (
		runsOn === undefined ||
		runsOn.scalar.value !== relayRunnerExpression(relay)
	) {
		const runsOnPair = pairOf(job, "runs-on");
		const at = runsOnPair ? ownLineKey(source, runsOnPair) : undefined;
		const start = at?.start ?? jobKey.start;
		return {
			why: `the runs-on of ${id} no longer reads the runner from ${relay}`,
			lines: linesOf(source, start, nextLineStart(source, start)),
		};
	}
	const needs = needsUndo(reading, job, relay);
	if ("why" in needs) return needs;
	const quote = quoteOf(runsOn.scalar);
	return [
		{ start: relayKey.lineStart, end: jobKey.lineStart, text: "", rank: index },
		...needs,
		{
			start: runsOn.start,
			end: runsOn.end,
			text: labelIn(github, runsOn.inFlow && quote === '"' ? "" : quote),
			rank: index,
		},
	];
}

/** The edit that takes the relay out of `needs`; none when it is not there. */
function needsUndo(
	reading: Reading,
	job: YAMLMap,
	relay: string,
): readonly Splice[] | Refusal {
	const { source, eol } = reading;
	const pair = pairOf(job, "needs");
	const value = pair && isNode(pair.value) ? pair.value : undefined;
	if (pair === undefined || value === undefined || isAlias(value)) return [];
	const refusal = (node: Node): Refusal => {
		const start = node.range?.[0] ?? 0;
		return {
			why: `the needs of the job behind ${relay} changed since hobo ci init wrote it`,
			lines: linesOf(source, start, nextLineStart(source, start)),
		};
	};
	if (isScalar(value)) {
		if (value.value !== relay) return [];
		const key = ownLineKey(source, pair);
		if (key === undefined) return refusal(value);
		const end = nextLineStart(source, key.start);
		if (
			source.slice(key.lineStart, end) !== `${key.indent}needs: ${relay}${eol}`
		)
			return refusal(value);
		return [{ start: key.lineStart, end, text: "", rank: 0 }];
	}
	if (!isSeq(value)) return [];
	const items = value.items;
	const at = items.findIndex((item) => isScalar(item) && item.value === relay);
	const item = items[at];
	if (!isScalar(item)) return [];
	const span = spanOf(source, item);
	if (!span) return refusal(value);
	if (value.flow !== true) {
		const lineStart = lineStartOf(source, span[0]);
		const end = nextLineStart(source, span[1]);
		const rest = source.slice(span[0], end);
		if (!/^ *- +$/u.test(source.slice(lineStart, span[0])))
			return refusal(item);
		if (rest === `${relay}${eol}`)
			return [{ start: lineStart, end, text: "", rank: 0 }];
		// The relay's line was the file's last: the line break before it goes too.
		if (rest === relay && end === source.length && lineStart >= eol.length)
			return [{ start: lineStart - eol.length, end, text: "", rank: 0 }];
		return refusal(item);
	}
	const whole = spanOf(source, value);
	const other = items[1];
	if (items.length === 2 && at === 0 && isScalar(other) && whole) {
		const otherText = textOf(source, other);
		if (source.slice(whole[0], whole[1]) === `[${relay}, ${otherText}]`)
			return [{ start: whole[0], end: whole[1], text: otherText, rank: 0 }];
	}
	const before = items[at - 1];
	const after = items[at + 1];
	if (at === items.length - 1 && before !== undefined && isNode(before)) {
		const beforeSpan = spanOf(source, before);
		if (!beforeSpan) return refusal(item);
		return [{ start: beforeSpan[1], end: span[1], text: "", rank: 0 }];
	}
	if (after !== undefined && isNode(after) && after.range)
		return [{ start: span[0], end: after.range[0], text: "", rank: 0 }];
	return [{ start: span[0], end: span[1], text: "", rank: 0 }];
}

/** Every relay job `hobo ci init --relay` could have written, in file order. */
export function findWorkflowRelays(source: string): readonly WorkflowRelay[] {
	const jobs = read(source).jobs;
	if (jobs === undefined) return [];
	return jobs.items.flatMap((pair) => {
		const relay = stringOf(isNode(pair.key) ? pair.key : undefined) ?? "";
		const node = pair.value;
		if (
			!relay.startsWith(RELAY_JOB_ID_PREFIX) ||
			!isMap(node) ||
			stringOf(nodeUnder(node, "uses")) !== RELAY_WORKFLOW_USES
		)
			return [];
		const withMap = nodeUnder(node, "with");
		return [
			{
				relay,
				job: relay.slice(RELAY_JOB_ID_PREFIX.length),
				github: isMap(withMap)
					? stringOf(nodeUnder(withMap, "github"))
					: undefined,
			},
		];
	});
}

/**
 * Takes relays out of a workflow file and gives each job back its label.
 * `jobs` are the ids of jobs behind a relay; the literal `all` selects every
 * relay. A relay changed since it was written in a way this cannot reverse is
 * left in place and listed in `refused` with the lines that stopped it.
 */
export function undoRelayPlan(
	source: string,
	jobs: readonly string[] = [EVERY_JOB],
): WorkflowUndoResult {
	const reading = read(source);
	const jobsMap = reading.jobs;
	if (jobsMap === undefined) return { source, restored: [], refused: [] };
	const every = jobs.includes(EVERY_JOB);
	const found = findWorkflowRelays(source).filter(
		(relay) => every || jobs.includes(relay.job),
	);
	const restored: string[] = [];
	const refused: {
		job: string;
		why: string;
		lines: readonly [number, number];
	}[] = [];
	const splices: Splice[] = [];
	for (const relay of found) {
		const index = jobsMap.items.findIndex(
			(pair) => isScalar(pair.key) && pair.key.value === relay.relay,
		);
		const result = undoSplices(reading, jobsMap, index);
		if ("why" in result) {
			refused.push({ job: relay.job, why: result.why, lines: result.lines });
			continue;
		}
		splices.push(...result.map((splice) => ({ ...splice, rank: index })));
		restored.push(relay.job);
	}
	if (splices.length === 0) return { source, restored: [], refused };
	return { source: applySplices(source, splices), restored, refused };
}

/**
 * Puts the chosen jobs behind a relay. `jobs` are job ids; the literal `all`
 * selects every ready job. Only a job `planWorkflow` calls ready is changed,
 * and only when undoing the change would give back the file byte for byte.
 * Every other job named is listed in `refused`.
 */
export function applyRelayPlan(
	file: string,
	source: string,
	jobs: readonly string[],
	options: WorkflowRelayOptions,
): WorkflowApplyResult {
	const selected = [...new Set(jobs)];
	const plan = planWorkflow(file, source, {
		includeSecretJobs: options.includeSecretJobs,
	});
	const reading = read(source);
	const jobsMap = reading.jobs;
	if (plan.error !== undefined || jobsMap === undefined) {
		const why = plan.error ?? reading.problem;
		return {
			source,
			changed: [],
			refused: selected.map((job) => ({ job, why })),
		};
	}
	const every = selected.includes(EVERY_JOB);
	const named = selected.filter((job) => job !== EVERY_JOB);
	const known = new Map(plan.jobs.map((job) => [job.job, job]));
	const refused: { job: string; why: string }[] = named.flatMap((job) => {
		const entry = known.get(job);
		if (entry === undefined) return [{ job, why: NO_SUCH_JOB }];
		return entry.verdict === "ready" ? [] : [{ job, why: NOT_READY }];
	});
	const chosen = plan.jobs.filter(
		(job) => job.verdict === "ready" && (every || named.includes(job.job)),
	);
	const accepted: { job: string; splices: readonly Splice[] }[] = [];
	for (const job of chosen) {
		const rank = jobsMap.items.findIndex(
			(pair) => isScalar(pair.key) && pair.key.value === job.job,
		);
		const splices = relaySplices(
			reading,
			jobsMap,
			job.job,
			job.runsOn,
			options.inputs,
			rank,
		);
		if ("why" in splices) {
			refused.push({ job: job.job, why: splices.why });
			continue;
		}
		const alone = applySplices(source, splices.splices);
		if (undoRelayPlan(alone, [job.job]).source !== source) {
			refused.push({ job: job.job, why: NOT_REVERSIBLE });
			continue;
		}
		accepted.push({ job: job.job, splices: splices.splices });
	}
	if (accepted.length === 0) return { source, changed: [], refused };
	const changed = accepted.map((entry) => entry.job);
	const rewritten = applySplices(
		source,
		accepted.flatMap((entry) => entry.splices),
	);
	const back = undoRelayPlan(rewritten, changed);
	if (back.source !== source || back.restored.length !== changed.length)
		return {
			source,
			changed: [],
			refused: [
				...refused,
				...changed.map((job) => ({ job, why: WOULD_NOT_READ_BACK })),
			],
		};
	return { source: rewritten, changed, refused };
}

/** The relay workflow for a mode: relay mode asks for `label` instead of a hosted runner. */
export function relayWorkflowText(
	mode: RelayInitMode,
	label: string = RELAY_LABEL,
): string {
	if (mode === "job") return RELAY_JOB_WORKFLOW;
	if (
		!RELAY_JOB_WORKFLOW.startsWith(WORKFLOW_HEAD) ||
		!RELAY_JOB_WORKFLOW.includes(JOB_MODE_RUNS_ON)
	)
		throw new Error(
			"The generated relay workflow no longer has the lines relay mode replaces.",
		);
	return RELAY_JOB_WORKFLOW.replace(WORKFLOW_HEAD, RELAY_WORKFLOW_HEAD).replace(
		JOB_MODE_RUNS_ON,
		[
			"",
			"    # Relay mode: a HoBo relay claims this job over the runner protocol",
			"    # and completes it with the outputs below. Its steps never run there.",
			`    runs-on: ${label}`,
			"",
		].join("\n"),
	);
}

/** The generated files a mode needs, as a repository should hold them. */
export function relayFilesFor(
	mode: RelayInitMode,
	label: string = RELAY_LABEL,
): readonly RelayFile[] {
	const workflow = {
		path: RELAY_WORKFLOW_FILE,
		text: relayWorkflowText(mode, label),
	};
	return mode === "job"
		? [workflow, { path: RELAY_EVALUATOR_FILE, text: RELAY_JOB_EVALUATOR }]
		: [workflow];
}

function workflowCheck(
	text: string | undefined,
	label: string,
): WorkflowFileCheck {
	const path = RELAY_WORKFLOW_FILE;
	if (text === undefined)
		return {
			mode: undefined,
			check: { path, state: "missing", detail: `${path} is not there.` },
		};
	const digest = sha256(text);
	if (digest === RELAY_JOB_WORKFLOW_SHA256)
		return {
			mode: "job",
			check: {
				path,
				state: "current",
				detail: `${path} is current (job mode).`,
			},
		};
	if (digest === sha256(relayWorkflowText("relay", label)))
		return {
			mode: "relay",
			check: {
				path,
				state: "current",
				detail: `${path} is current (relay mode).`,
			},
		};
	const mode: RelayInitMode | undefined = text.startsWith(RELAY_WORKFLOW_HEAD)
		? "relay"
		: text.startsWith(WORKFLOW_HEAD)
			? "job"
			: undefined;
	return {
		mode,
		check: {
			path,
			state: "stale",
			detail: `${path} is not the one this hobo writes: another version wrote it, or it was edited.`,
		},
	};
}

function evaluatorCheck(
	text: string | undefined,
	needed: boolean,
): RelayFileCheck {
	const path = RELAY_EVALUATOR_FILE;
	if (text === undefined)
		return needed
			? { path, state: "missing", detail: `${path} is not there.` }
			: {
					path,
					state: "not_needed",
					detail: `${path} is not there, and relay mode does not run it.`,
				};
	const headerEnd = text.indexOf(HEADER_END);
	const stated = HEADER_SHA.exec(text.slice(0, Math.max(0, headerEnd)))?.[1];
	if (headerEnd === -1 || stated === undefined)
		return {
			path,
			state: "edited",
			detail: `${path} has no generated header, so it was not written by hobo or was edited.`,
		};
	if (sha256(text.slice(headerEnd + HEADER_END.length)) !== stated)
		return {
			path,
			state: "edited",
			detail: `${path} was edited: its body no longer has the SHA-256 its header states.`,
		};
	if (stated !== RELAY_JOB_EVALUATOR_SHA256)
		return {
			path,
			state: "stale",
			detail: `${path} was generated by another version of hobo (sha256 ${stated.slice(0, 12)}, this one writes ${RELAY_JOB_EVALUATOR_SHA256.slice(0, 12)}).`,
		};
	return { path, state: "current", detail: `${path} is current.` };
}

/**
 * Whether a repository's copies of the relay files are the ones this build
 * writes. The workflow is compared whole; the evaluator by the SHA-256 its
 * header states and the SHA-256 of its body. Relay mode does not need the
 * evaluator, so its absence is no fault there.
 */
export function checkRelayFiles(
	found: Readonly<{
		workflow: string | undefined;
		evaluator: string | undefined;
	}>,
	label: string = RELAY_LABEL,
): RelayFilesCheck {
	const workflow = workflowCheck(found.workflow, label);
	const evaluator = evaluatorCheck(found.evaluator, workflow.mode !== "relay");
	const files = [workflow.check, evaluator];
	return {
		mode: workflow.mode,
		files,
		current: files.every(
			(file) => file.state === "current" || file.state === "not_needed",
		),
	};
}
