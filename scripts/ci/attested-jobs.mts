/**
 * What a local run executes for each workflow job it may stand in for.
 *
 * `attested-jobs.json` is the one description: each covered job's condition,
 * environment and ordered steps, copied from the workflow as written, plus
 * what a local run does with each step (`run` it, or `skip` it and why). The
 * local runner reads only that file. It never reads a workflow, so what it
 * executes is what was reviewed there, and `scripts/test/attested-jobs.test.ts`
 * fails when a workflow and the description drift apart.
 *
 * The description keeps GitHub's own `${{ }}` expressions as its placeholders
 * for the base, the event and the shard. `evaluateExpression` gives them a
 * value on a developer's machine; an expression it does not know is an error,
 * never a guess.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	asBoolean,
	asList,
	asNumber,
	asObject,
	asText,
	COVERED_JOBS,
	type CoveredJob,
	type JsonValue,
	parseJson,
} from "./attestation.mts";

export const PLAN_PATH = join(import.meta.dirname, "attested-jobs.json");

export type PlannedStep = Readonly<{
	name?: string;
	id?: string;
	if?: string;
	uses?: string;
	run?: string;
	shell?: string;
	env?: Readonly<Record<string, string>>;
	continueOnError?: boolean;
	/** What a local run does with this step. */
	local: "run" | "skip";
	/** Why a skipped step is not needed on a developer's machine. */
	reason?: string;
}>;

/** A step output that, when it is not empty, means this job is not one a local run can cover. */
export type UncoveredWhen = Readonly<{
	step: string;
	output: string;
	reason: string;
}>;

export type PlannedJob = Readonly<{
	id: CoveredJob;
	workflow: string;
	if?: string;
	/** The workflow's top-level `env`. */
	workflowEnv: Readonly<Record<string, string>>;
	env: Readonly<Record<string, string>>;
	outputs: Readonly<Record<string, string>>;
	/** The expression for `strategy.matrix.shard`, for a job that fans out. */
	matrix?: string;
	uncoveredWhen?: UncoveredWhen;
	steps: readonly PlannedStep[];
}>;

export class PlanError extends Error {}

function need<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new PlanError(what);
	return value;
}

function textRecord(
	value: JsonValue | undefined,
	what: string,
): Record<string, string> {
	const entries = Object.entries(
		need(asObject(value), `${what} must be an object`),
	).map(([key, entry]): [string, string] => [
		key,
		need(asText(entry), `${what}.${key} must be a string`),
	]);
	return Object.fromEntries(entries);
}

/** A step or job while its optional fields are being filled in. */
type StepDraft = { -readonly [Key in keyof PlannedStep]: PlannedStep[Key] };
type JobDraft = { -readonly [Key in keyof PlannedJob]: PlannedJob[Key] };

function plannedStep(value: JsonValue, at: string): PlannedStep {
	const source = need(asObject(value), `${at} must be an object`);
	const local = asText(source.local);
	if (local !== "run" && local !== "skip")
		throw new PlanError(`${at} must say local: run or skip`);
	const step: StepDraft = { local };
	const name = asText(source.name);
	const id = asText(source.id);
	const condition = asText(source.if);
	const uses = asText(source.uses);
	const run = asText(source.run);
	const shell = asText(source.shell);
	const reason = asText(source.reason);
	if (name !== undefined) step.name = name;
	if (id !== undefined) step.id = id;
	if (condition !== undefined) step.if = condition;
	if (uses !== undefined) step.uses = uses;
	if (run !== undefined) step.run = run;
	if (shell !== undefined) step.shell = shell;
	if (source.env !== undefined) step.env = textRecord(source.env, `${at}.env`);
	if (asBoolean(source.continueOnError) === true) step.continueOnError = true;
	if (reason !== undefined) step.reason = reason;
	if (local === "run" && run === undefined)
		throw new PlanError(`${at} has nothing to run`);
	if (local === "skip" && !reason)
		throw new PlanError(`${at} is skipped without a reason`);
	return step;
}

function plannedJob(value: JsonValue): PlannedJob {
	const source = need(asObject(value), "a planned job must be an object");
	const id = COVERED_JOBS.find((covered) => covered === asText(source.id));
	if (!id)
		throw new PlanError(`${asText(source.id) ?? "?"} is not a covered job`);
	const job: JobDraft = {
		id,
		workflow: need(asText(source.workflow), `${id} needs its workflow`),
		workflowEnv: textRecord(source.workflowEnv, `${id}.workflowEnv`),
		env: textRecord(source.env, `${id}.env`),
		outputs: textRecord(source.outputs, `${id}.outputs`),
		steps: need(asList(source.steps), `${id}.steps must be a list`).map(
			(step, index) => plannedStep(step, `${id} step ${index + 1}`),
		),
	};
	const condition = asText(source.if);
	const matrix = asText(source.matrix);
	const uncovered = asObject(source.uncoveredWhen);
	if (condition !== undefined) job.if = condition;
	if (matrix !== undefined) job.matrix = matrix;
	if (uncovered)
		job.uncoveredWhen = {
			step: need(asText(uncovered.step), `${id}.uncoveredWhen.step`),
			output: need(asText(uncovered.output), `${id}.uncoveredWhen.output`),
			reason: need(asText(uncovered.reason), `${id}.uncoveredWhen.reason`),
		};
	return job;
}

/** The covered jobs in the order a local run executes them. */
export function parsePlan(text: string): PlannedJob[] {
	const jobs = need(
		asList(asObject(parseJson(text))?.jobs),
		"the plan must list its jobs",
	).map(plannedJob);
	if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
		throw new PlanError("a job appears twice in the plan");
	return jobs;
}

export function loadPlan(path: string = PLAN_PATH): PlannedJob[] {
	return parsePlan(readFileSync(path, "utf8"));
}

/** A value an expression can have. */
export type ExprValue = JsonValue;

export class ExpressionError extends Error {}

type Token = Readonly<{
	kind: "op" | "text" | "number" | "name";
	text: string;
}>;

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const rest = source.slice(at);
		const space = /^\s+/u.exec(rest);
		if (space) {
			at += space[0].length;
			continue;
		}
		const op = /^(\|\||&&|==|!=|!|\(|\)|,)/u.exec(rest);
		if (op) {
			tokens.push({ kind: "op", text: op[0] });
			at += op[0].length;
			continue;
		}
		const text = /^'((?:[^']|'')*)'/u.exec(rest);
		if (text) {
			tokens.push({
				kind: "text",
				text: (text[1] ?? "").replaceAll("''", "'"),
			});
			at += text[0].length;
			continue;
		}
		const number = /^-?\d+(\.\d+)?/u.exec(rest);
		if (number) {
			tokens.push({ kind: "number", text: number[0] });
			at += number[0].length;
			continue;
		}
		const name = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*/u.exec(
			rest,
		);
		if (name) {
			tokens.push({ kind: "name", text: name[0] });
			at += name[0].length;
			continue;
		}
		throw new ExpressionError(`cannot read "${rest}" in "${source}"`);
	}
	return tokens;
}

/** GitHub's truthiness: false, 0, the empty string and null are false. */
export function truthy(value: ExprValue): boolean {
	return !(value === null || value === false || value === 0 || value === "");
}

function asComparable(value: ExprValue): number {
	if (value === null) return 0;
	const flag = asBoolean(value);
	if (flag !== undefined) return flag ? 1 : 0;
	const number = asNumber(value);
	if (number !== undefined) return number;
	const text = asText(value);
	if (text !== undefined) return text === "" ? 0 : Number(text);
	return Number.NaN;
}

/** GitHub's loose equality: strings ignore case, unlike types compare as numbers. */
function looseEquals(left: ExprValue, right: ExprValue): boolean {
	const leftText = asText(left);
	const rightText = asText(right);
	if (leftText !== undefined && rightText !== undefined)
		return leftText.toLowerCase() === rightText.toLowerCase();
	return asComparable(left) === asComparable(right);
}

/** A value as the text GitHub substitutes for `${{ }}`. */
export function expressionText(value: ExprValue): string {
	if (value === null) return "";
	return asText(value) ?? JSON.stringify(value);
}

/** Gives a context path such as `github.event_name` its value; throws for one it does not know. */
export type ContextLookup = (path: string) => ExprValue;

/** A local run reaches a step only after everything before it passed. */
const STATUS_FUNCTIONS = new Map([
	["always", true],
	["success", true],
	["cancelled", false],
	["failure", false],
]);

/**
 * The value of one GitHub Actions expression (without its `${{ }}`), for the
 * part of the language the covered jobs use: literals, context paths, `!`,
 * `==`, `!=`, `&&`, `||`, parentheses, the status functions, `contains` and
 * `fromJSON`. A local run reaches a step only after everything before it
 * passed, so `success()` and `always()` are true and `failure()` and
 * `cancelled()` are false.
 */
export function evaluateExpression(
	source: string,
	lookup: ContextLookup,
): ExprValue {
	const tokens = tokenize(source);
	let at = 0;
	const peek = () => tokens[at];
	const take = () => tokens[at++];
	const isOp = (text: string) => peek()?.kind === "op" && peek()?.text === text;
	const expect = (text: string) => {
		if (!isOp(text))
			throw new ExpressionError(`expected "${text}" in "${source}"`);
		at += 1;
	};

	const call = (name: string, args: readonly ExprValue[]): ExprValue => {
		const status = STATUS_FUNCTIONS.get(name.toLowerCase());
		if (status !== undefined) return status;
		if (name.toLowerCase() === "contains") {
			const [haystack = null, needle = null] = args;
			const list = asList(haystack);
			if (list) return list.some((entry) => looseEquals(entry, needle));
			return expressionText(haystack)
				.toLowerCase()
				.includes(expressionText(needle).toLowerCase());
		}
		if (name.toLowerCase() === "fromjson")
			return parseJson(expressionText(args[0] ?? null));
		throw new ExpressionError(`${name}() is not known here, in "${source}"`);
	};

	const primary = (): ExprValue => {
		const token = take();
		if (!token) throw new ExpressionError(`"${source}" ends early`);
		if (token.kind === "text") return token.text;
		if (token.kind === "number") return Number(token.text);
		if (token.kind === "op" && token.text === "(") {
			const value = or();
			expect(")");
			return value;
		}
		if (token.kind === "op" && token.text === "!") return !truthy(primary());
		if (token.kind !== "name")
			throw new ExpressionError(`unexpected "${token.text}" in "${source}"`);
		if (isOp("(")) {
			at += 1;
			const args: ExprValue[] = [];
			while (!isOp(")")) {
				args.push(or());
				if (isOp(",")) at += 1;
			}
			expect(")");
			return call(token.text, args);
		}
		if (token.text === "true") return true;
		if (token.text === "false") return false;
		if (token.text === "null") return null;
		return lookup(token.text);
	};
	const equality = (): ExprValue => {
		let left = primary();
		while (isOp("==") || isOp("!=")) {
			const negate = take()?.text === "!=";
			const same = looseEquals(left, primary());
			left = negate ? !same : same;
		}
		return left;
	};
	const and = (): ExprValue => {
		let left = equality();
		while (isOp("&&")) {
			at += 1;
			const right = equality();
			left = truthy(left) ? right : left;
		}
		return left;
	};
	function or(): ExprValue {
		let left = and();
		while (isOp("||")) {
			at += 1;
			const right = and();
			left = truthy(left) ? left : right;
		}
		return left;
	}

	const value = or();
	if (at !== tokens.length)
		throw new ExpressionError(`"${source}" has something left over`);
	return value;
}

const EMBEDDED = /\$\{\{(.*?)\}\}/gsu;

/** Text with each `${{ }}` replaced by its value, as GitHub does before a step runs. */
export function substituteExpressions(
	text: string,
	lookup: ContextLookup,
): string {
	return text.replace(EMBEDDED, (_match, source: string) =>
		expressionText(evaluateExpression(source.trim(), lookup)),
	);
}

/** Whether an `if:` holds; with or without `${{ }}` around it, and true when there is none. */
export function conditionHolds(
	condition: string | undefined,
	lookup: ContextLookup,
): boolean {
	if (condition === undefined) return true;
	const whole = /^\s*\$\{\{(.*)\}\}\s*$/su.exec(condition);
	return truthy(evaluateExpression((whole?.[1] ?? condition).trim(), lookup));
}

/** Every expression a planned job holds, for checking that each can be evaluated. */
export function expressionsOf(job: PlannedJob): string[] {
	const embedded = (text: string) =>
		[...text.matchAll(EMBEDDED)].map((match) => (match[1] ?? "").trim());
	const condition = (text: string | undefined) => {
		if (text === undefined) return [];
		const whole = /^\s*\$\{\{(.*)\}\}\s*$/su.exec(text);
		return [(whole?.[1] ?? text).trim()];
	};
	const maps = (record: Readonly<Record<string, string>>) =>
		Object.values(record).flatMap(embedded);
	return [
		...condition(job.if),
		...maps(job.workflowEnv),
		...maps(job.env),
		...maps(job.outputs),
		...(job.matrix === undefined ? [] : embedded(job.matrix)),
		...job.steps
			.filter((step) => step.local === "run")
			.flatMap((step) => [
				...condition(step.if),
				...maps(step.env ?? {}),
				...embedded(step.run ?? ""),
			]),
	];
}
