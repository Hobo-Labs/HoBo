/**
 * The relay job's records and the names every part of it agrees on.
 *
 * A relay job is the small job a workflow puts in front of the real one to
 * ask "which runner should this run on". Two answerers exist over one engine
 * (ADR-0183): in job mode a vendored evaluator answers it on a GitHub-hosted
 * runner; in relay mode a HoBo node claims it over the runner protocol. Both
 * read a `RelayJobMessage` and produce a `RelayJobAnswer`; both journal a
 * `RunnerRouteEvent`.
 *
 * The records are protobuf (`data-models/relay_job.proto`) with CUE rules
 * (`data-models/relay_job.cue`). Each parser here returns the generated record,
 * checked against the same rules and frozen. The conversions turn the stored
 * records into the shapes the walk and the insight reports already read.
 *
 * Pure functions: no clock, network or store.
 */
import { create, fromJsonString } from "@bufbuild/protobuf";
import {
	type JobFact,
	JobFactSchema,
	type MachineAdvert,
	MachineAdvertSchema,
	type ProviderHealthRecord,
	ProviderHealthRecordSchema,
	ProviderOutcomeRecordSchema,
	type RelayJobAnswer,
	RelayJobAnswerSchema,
	type RelayJobMessage,
	RelayJobMessageSchema,
	type RelayJobValue,
	type RunFact,
	RunFactSchema,
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
	type StepFact,
	StepFactSchema,
} from "../_generated/relay_job_pb.js";
import {
	type RunnerRouteRequest,
	RunnerRouteRequestSchema,
} from "../_generated/runner_route_pb.js";
import type {
	InsightConclusion,
	InsightJob,
	InsightRun,
	InsightStep,
} from "../insights/types.js";
import type { ProviderHealth } from "./health.js";
import { relayInputLabels } from "./inputs.js";
import { MACHINE_SHARING, type MachineCandidate } from "./machines.js";
import { RUNNER_STEP_KEYS, runnerStepKey } from "./providers.js";

// public-contract: the label a relay job asks for in relay mode.
export const RELAY_LABEL = "hobo-relay";

/**
 * `relayJobs` in `.hobo/ci.json`: whether a relay answers relay jobs at all,
 * and the label it answers. Off unless a repository turns it on.
 */
export type RelayJobsConfig = Readonly<{ answer: boolean; label: string }>;
// public-contract: the `relayJobs` a repository gets when it writes none.
export const DEFAULT_RELAY_JOBS: RelayJobsConfig = Object.freeze({
	answer: false,
	label: RELAY_LABEL,
});

// public-contract: every input a relay job may take; one per runner type, then `size` and `first`.
export const RELAY_JOB_INPUTS = [...RUNNER_STEP_KEYS, "size", "first"] as const;
export type RelayJobInputName = (typeof RELAY_JOB_INPUTS)[number];

// public-contract: every output a relay job sets.
export const RELAY_JOB_OUTPUTS = [
	"runner",
	"step",
	"outcome",
	"reason",
] as const;
export type RelayJobOutputName = (typeof RELAY_JOB_OUTPUTS)[number];

// public-contract: the files `hobo ci init --relay` writes into a user's repository.
export const RELAY_WORKFLOW_FILE = ".github/workflows/hobo-relay.yml";
// public-contract: the vendored job-mode evaluator `hobo ci init --relay` writes.
export const RELAY_EVALUATOR_FILE = ".hobo-ci/relay.mjs";

// public-contract: a `uses:` ending in one of these is a HoBo check step.
export const RELAY_CHECK_STEP_SUFFIXES = [
	"/checks/pr-title",
	"/checks/lint",
] as const;

// public-contract: the two route journal event types.
export const RUNNER_ROUTE_EVENT_TYPES = [
	"runner.route.Requested",
	"runner.route.Decided",
] as const;
export type RunnerRouteEventType = (typeof RUNNER_ROUTE_EVENT_TYPES)[number];

// public-contract: every event the relay, machines, retries and checks emit.
export const RELAY_EVENT_TYPES = [
	...RUNNER_ROUTE_EVENT_TYPES,
	"machine.connected",
	"machine.disconnected",
	"machine.paused",
	"machine.resumed",
	"machine.sharing_changed",
	"machine.removed",
	"machine.taken_over",
	"job.retried",
	"check.completed",
] as const;
export type RelayEventType = (typeof RELAY_EVENT_TYPES)[number];

// public-contract: how a relay job is answered.
export const RELAY_MODES = ["job", "relay"] as const;
export type RelayMode = (typeof RELAY_MODES)[number];

// public-contract: how a relay job ends.
export const RELAY_JOB_CONCLUSIONS = ["succeeded", "failed"] as const;
export type RelayJobConclusion = (typeof RELAY_JOB_CONCLUSIONS)[number];

// public-contract: the levels a relay job annotation can carry.
export const RELAY_ANNOTATION_LEVELS = ["error", "warning", "notice"] as const;

// public-contract: how a machine runs a job.
export const MACHINE_ISOLATIONS = ["container", "host"] as const;
export type MachineIsolation = (typeof MACHINE_ISOLATIONS)[number];
// public-contract: the operating systems a machine advert names.
export const MACHINE_OSES = ["linux", "macos", "windows"] as const;
// public-contract: the architectures a machine advert names.
export const MACHINE_ARCHES = ["x64", "arm64", "arm"] as const;

// public-contract: the `hobo ci` commands the relay build adds.
export const RELAY_CI_COMMANDS = [
	"machine",
	"runners",
	"activity",
	"usage",
	"performance",
	"provider-health",
	"relay",
] as const;

// public-contract: the read API paths, under `/v1/accounts/self/`.
export const RELAY_READ_API_PATHS = [
	"/v1/accounts/self/runner-order",
	"/v1/accounts/self/routes",
	"/v1/accounts/self/machines",
	"/v1/accounts/self/runs",
	"/v1/accounts/self/signals",
	"/v1/accounts/self/job-times",
	"/v1/accounts/self/usage",
	"/v1/accounts/self/runs/{id}/{attempt}/jobs",
] as const;

// public-contract: the read-only MCP tools the relay build adds.
export const RELAY_MCP_TOOLS = [
	"get_runner_order",
	"explain_route",
	"list_route_decisions",
	"list_machines",
	"get_signals",
	"get_job_times",
	"get_run_failures",
	"get_usage",
] as const;

// public-contract: where the generated parity scorecard lives.
export const PARITY_SCORECARD_PATH = "docs/ci/parity-scorecard.md";

/** The tags a parity scenario carries: `@parity @<case id> @t2` (or `@t3`). */
export function parityTags(
	caseId: string,
	tier: "t2" | "t3",
): readonly string[] {
	return ["@parity", `@${caseId}`, `@${tier}`];
}

const INSIGHT_CONCLUSIONS: readonly InsightConclusion[] = [
	"success",
	"failure",
	"cancelled",
	"skipped",
	"timed_out",
	"unknown",
];

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u;
const EVENT = /^[a-z_]{1,60}$/u;
const VALUE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const USER_ID = /^[0-9]{1,20}$/u;

declare const parsedRelayRecord: unique symbol;
/** A record that passed its parser: every rule in `relay_job.cue` holds, and it is frozen. */
export type ParsedRelayRecord<T> = T & { readonly [parsedRelayRecord]: true };

/** A relay record broke one of its rules. The message names the rule. */
export class RelayRecordRejection extends Error {
	override readonly name = "RelayRecordRejection";
}

function need(ok: boolean, problem: string): void {
	if (!ok) throw new RelayRecordRejection(problem);
}

function oneOf<T extends string>(
	values: readonly T[],
	value: string,
): value is T {
	return values.some((entry) => entry === value);
}

function freezeValues(values: readonly RelayJobValue[]): void {
	for (const value of values) Object.freeze(value);
	Object.freeze(values);
}

function branded<T>(value: T): ParsedRelayRecord<T> {
	// SAFETY: every caller checked the record's rules and froze it first.
	return value as ParsedRelayRecord<T>;
}

function valueNamesProblem(
	values: readonly RelayJobValue[],
	what: string,
): string | undefined {
	const seen = new Set<string>();
	for (const value of values) {
		if (!VALUE_NAME.test(value.name))
			return `${what} "${value.name}" is not a lower-case name`;
		if (seen.has(value.name)) return `${what} "${value.name}" appears twice`;
		seen.add(value.name);
	}
	return undefined;
}

/** A relay job message, checked and frozen. */
export function defineRelayJobMessage(
	message: RelayJobMessage,
): ParsedRelayRecord<RelayJobMessage> {
	need(message.jobId.length > 0, "a relay job message needs a job id");
	need(message.planId.length > 0, "a relay job message needs a plan id");
	need(REPOSITORY.test(message.repository), "repository is owner/name");
	need(
		Number.isSafeInteger(message.runId) && message.runId > 0,
		"runId is a positive integer",
	);
	need(
		message.runAttempt >= 1 && message.runAttempt <= 1000,
		"runAttempt is 1 to 1000",
	);
	need(JOB_ID.test(message.job), "job is a workflow job id");
	need(EVENT.test(message.event), "event is a GitHub event name");
	for (const id of [message.actorId, message.triggeringActorId])
		need(id === "" || USER_ID.test(id), "an actor id is a GitHub user id");
	const problem = valueNamesProblem(message.inputs, "relay input");
	need(problem === undefined, problem ?? "");
	freezeValues(message.inputs);
	for (const step of message.steps) {
		for (const value of step.inputs) Object.freeze(value);
		Object.freeze(step.inputs);
		Object.freeze(step);
	}
	Object.freeze(message.steps);
	return branded(Object.freeze(message));
}

/** Parse protobuf JSON for a `RelayJobMessage`. Throws on an unknown field or a broken rule. */
export function parseRelayJobMessage(
	json: string,
): ParsedRelayRecord<RelayJobMessage> {
	return defineRelayJobMessage(fromJsonString(RelayJobMessageSchema, json));
}

/** A relay job answer, checked and frozen. A failed answer must say why. */
export function defineRelayJobAnswer(
	answer: RelayJobAnswer,
): ParsedRelayRecord<RelayJobAnswer> {
	need(answer.jobId.length > 0, "a relay job answer needs a job id");
	need(answer.planId.length > 0, "a relay job answer needs a plan id");
	need(
		oneOf(RELAY_JOB_CONCLUSIONS, answer.conclusion),
		'conclusion is "succeeded" or "failed"',
	);
	need(
		answer.conclusion !== "failed" || answer.annotations.length > 0,
		"a failed answer carries at least one annotation saying why",
	);
	for (const note of answer.annotations) {
		need(
			oneOf(RELAY_ANNOTATION_LEVELS, note.level),
			'an annotation level is "error", "warning" or "notice"',
		);
		need(note.message.length > 0, "an annotation needs a message");
		Object.freeze(note);
	}
	Object.freeze(answer.annotations);
	const problem = valueNamesProblem(answer.outputs, "relay output");
	need(problem === undefined, problem ?? "");
	freezeValues(answer.outputs);
	return branded(Object.freeze(answer));
}

/** Parse protobuf JSON for a `RelayJobAnswer`. */
export function parseRelayJobAnswer(
	json: string,
): ParsedRelayRecord<RelayJobAnswer> {
	return defineRelayJobAnswer(fromJsonString(RelayJobAnswerSchema, json));
}

/** A route journal entry, checked and frozen. A decision is on `Decided` and nowhere else. */
export function defineRunnerRouteEvent(
	event: RunnerRouteEvent,
): ParsedRelayRecord<RunnerRouteEvent> {
	need(
		oneOf(RUNNER_ROUTE_EVENT_TYPES, event.type),
		"type is runner.route.Requested or runner.route.Decided",
	);
	need(event.accountId.length > 0, "a route event needs an account id");
	need(
		Number.isSafeInteger(event.atMs) && event.atMs > 0,
		"atMs is epoch milliseconds",
	);
	need(event.request !== undefined, "a route event carries its request");
	need(
		(event.type === "runner.route.Decided") === (event.decision !== undefined),
		"a decision is on runner.route.Decided and nowhere else",
	);
	need(oneOf(RELAY_MODES, event.mode), 'mode is "job" or "relay"');
	need(event.node.length > 0, "a route event names the node that answered");
	return branded(Object.freeze(event));
}

/** Parse protobuf JSON for a `RunnerRouteEvent`. */
export function parseRunnerRouteEvent(
	json: string,
): ParsedRelayRecord<RunnerRouteEvent> {
	return defineRunnerRouteEvent(fromJsonString(RunnerRouteEventSchema, json));
}

/** A machine advert, checked and frozen. */
export function defineMachineAdvert(
	advert: MachineAdvert,
): ParsedRelayRecord<MachineAdvert> {
	need(advert.id.length > 0, "a machine needs an id");
	need(advert.accountId.length > 0, "a machine names the account it serves");
	need(advert.name.length > 0, "a machine needs a name");
	need(advert.runsOn.length > 0, "a machine needs its runs-on label");
	need(oneOf(MACHINE_OSES, advert.os), "os is linux, macos or windows");
	need(oneOf(MACHINE_ARCHES, advert.arch), "arch is x64, arm64 or arm");
	need(advert.slots >= 1 && advert.slots <= 1000, "slots is 1 to 1000");
	need(advert.busy <= 1000, "busy is at most 1000");
	need(
		oneOf(MACHINE_SHARING, advert.sharing),
		'sharing is "only_me" or "anyone"',
	);
	need(USER_ID.test(advert.ownerId), "ownerId is a GitHub user id");
	need(advert.ownerLogin.length > 0, "a machine names its owner's login");
	need(
		advert.repository === "" || REPOSITORY.test(advert.repository),
		"repository is owner/name",
	);
	need(advert.signerKeyId.length > 0, "a machine names its signing key");
	need(
		oneOf(MACHINE_ISOLATIONS, advert.isolation),
		'isolation is "container" or "host"',
	);
	Object.freeze(advert.labels);
	return branded(Object.freeze(advert));
}

/** Parse protobuf JSON for a `MachineAdvert`. */
export function parseMachineAdvert(
	json: string,
): ParsedRelayRecord<MachineAdvert> {
	return defineMachineAdvert(fromJsonString(MachineAdvertSchema, json));
}

/**
 * What the walk needs of an advertised machine. Whether it is online (its
 * advert is fresh) and whether its owner can read the job's repository are
 * facts the caller holds; the advert does not.
 */
export function machineCandidate(
	advert: MachineAdvert,
	known: Readonly<{ online: boolean; ownerCanRead: boolean }>,
): MachineCandidate {
	return {
		id: advert.id,
		name: advert.name,
		runsOn: advert.runsOn,
		labels: advert.labels,
		online: known.online,
		paused: advert.paused,
		slots: advert.slots,
		busy: advert.busy,
		sharing: advert.sharing === "anyone" ? "anyone" : "only_me",
		ownerId: advert.ownerId,
		ownerCanRead: known.ownerCanRead,
		lastPickedAtMs: advert.lastPickedAtMs,
		repository: advert.repository === "" ? undefined : advert.repository,
	};
}

/** A stored provider health record, checked and frozen. */
export function defineProviderHealthRecord(
	record: ProviderHealthRecord,
): ParsedRelayRecord<ProviderHealthRecord> {
	need(
		/^[a-z-]+:.+$/u.test(record.key),
		"key is provider:label, as providerHealthKey makes it",
	);
	need(
		record.outcomes.length <= 16,
		"a health record keeps at most 16 outcomes",
	);
	for (const outcome of record.outcomes) Object.freeze(outcome);
	Object.freeze(record.outcomes);
	return branded(Object.freeze(record));
}

/** Parse protobuf JSON for a `ProviderHealthRecord`. */
export function parseProviderHealthRecord(
	json: string,
): ParsedRelayRecord<ProviderHealthRecord> {
	return defineProviderHealthRecord(
		fromJsonString(ProviderHealthRecordSchema, json),
	);
}

/** The record a store keeps for one runner type's health. */
export function providerHealthRecord(
	key: string,
	health: ProviderHealth,
): ParsedRelayRecord<ProviderHealthRecord> {
	return defineProviderHealthRecord(
		create(ProviderHealthRecordSchema, {
			key,
			outcomes: health.outcomes.map((outcome) =>
				create(ProviderOutcomeRecordSchema, outcome),
			),
			trippedAtMs: health.trippedAtMs,
			backoffMs: health.backoffMs,
			nextTrialAtMs: health.nextTrialAtMs,
			trialStartedAtMs: health.trialStartedAtMs,
		}),
	);
}

/** The health a stored record holds, as `recordProviderOutcome` reads it. */
export function providerHealthOf(record: ProviderHealthRecord): ProviderHealth {
	return {
		outcomes: record.outcomes.map((outcome) => ({
			atMs: outcome.atMs,
			started: outcome.started,
		})),
		trippedAtMs: record.trippedAtMs,
		backoffMs: record.backoffMs,
		nextTrialAtMs: record.nextTrialAtMs,
		trialStartedAtMs: record.trialStartedAtMs,
	};
}

function conclusion(text: string): InsightConclusion {
	return INSIGHT_CONCLUSIONS.find((entry) => entry === text) ?? "unknown";
}

/** A stored run fact, checked and frozen. */
export function defineRunFact(run: RunFact): ParsedRelayRecord<RunFact> {
	need(Number.isSafeInteger(run.id) && run.id > 0, "id is a run id");
	need(run.attempt >= 1, "attempt starts at 1");
	need(REPOSITORY.test(run.repository), "repository is owner/name");
	need(/^[0-9a-f]{40}$/u.test(run.headSha), "headSha is a commit sha");
	const known = (text: string): boolean => oneOf(INSIGHT_CONCLUSIONS, text);
	need(known(run.conclusion), `unknown run conclusion "${run.conclusion}"`);
	for (const job of run.jobs) {
		need(known(job.conclusion), `unknown job conclusion "${job.conclusion}"`);
		for (const step of job.steps) {
			need(
				known(step.conclusion),
				`unknown step conclusion "${step.conclusion}"`,
			);
			need(step.number >= 1, "a step number starts at 1");
			Object.freeze(step);
		}
		Object.freeze(job.steps);
		Object.freeze(job.labels);
		Object.freeze(job.needs);
		Object.freeze(job);
	}
	Object.freeze(run.jobs);
	Object.freeze(run.changedPaths);
	return branded(Object.freeze(run));
}

/** Parse protobuf JSON for a `RunFact`. */
export function parseRunFact(json: string): ParsedRelayRecord<RunFact> {
	return defineRunFact(fromJsonString(RunFactSchema, json));
}

function insightStep(step: StepFact): InsightStep {
	return {
		name: step.name,
		number: step.number,
		conclusion: conclusion(step.conclusion),
		...(step.startedAtMs === undefined
			? undefined
			: { startedAtMs: step.startedAtMs }),
		...(step.completedAtMs === undefined
			? undefined
			: { completedAtMs: step.completedAtMs }),
	};
}

function insightJob(job: JobFact): InsightJob {
	return {
		id: job.id,
		name: job.name,
		labels: job.labels,
		...(job.runnerName === undefined
			? undefined
			: { runnerName: job.runnerName }),
		...(job.runnerGroup === undefined
			? undefined
			: { runnerGroup: job.runnerGroup }),
		conclusion: conclusion(job.conclusion),
		queuedAtMs: job.queuedAtMs,
		...(job.startedAtMs === undefined
			? undefined
			: { startedAtMs: job.startedAtMs }),
		...(job.completedAtMs === undefined
			? undefined
			: { completedAtMs: job.completedAtMs }),
		steps: job.steps.map(insightStep),
		...(job.needs.length === 0 ? undefined : { needs: job.needs }),
		billed: job.billed,
		...(job.relay ? { relay: true } : undefined),
	};
}

/** The run a stored fact holds, as the insight reports read it. */
export function insightRunOf(run: RunFact): InsightRun {
	return {
		id: run.id,
		attempt: run.attempt,
		repository: run.repository,
		workflow: run.workflow,
		workflowPath: run.workflowPath,
		event: run.event,
		branch: run.branch,
		defaultBranch: run.defaultBranch,
		headSha: run.headSha,
		actor: run.actor,
		conclusion: conclusion(run.conclusion),
		createdAtMs: run.createdAtMs,
		...(run.completedAtMs === undefined
			? undefined
			: { completedAtMs: run.completedAtMs }),
		jobs: run.jobs.map(insightJob),
		...(run.changedPaths.length === 0
			? undefined
			: { changedPaths: run.changedPaths }),
		...(run.title === undefined ? undefined : { title: run.title }),
	};
}

/** The fact a store keeps for one run attempt. An empty `needs` or `changedPaths` reads back as not known. */
export function runFactOf(run: InsightRun): ParsedRelayRecord<RunFact> {
	return defineRunFact(
		create(RunFactSchema, {
			id: run.id,
			attempt: run.attempt,
			repository: run.repository,
			workflow: run.workflow,
			workflowPath: run.workflowPath,
			event: run.event,
			branch: run.branch,
			defaultBranch: run.defaultBranch,
			headSha: run.headSha,
			actor: run.actor,
			conclusion: run.conclusion,
			createdAtMs: run.createdAtMs,
			completedAtMs: run.completedAtMs,
			jobs: run.jobs.map((job) =>
				create(JobFactSchema, {
					id: job.id,
					name: job.name,
					labels: [...job.labels],
					runnerName: job.runnerName,
					runnerGroup: job.runnerGroup,
					conclusion: job.conclusion,
					queuedAtMs: job.queuedAtMs,
					startedAtMs: job.startedAtMs,
					completedAtMs: job.completedAtMs,
					steps: job.steps.map((step) => create(StepFactSchema, step)),
					needs: [...(job.needs ?? [])],
					billed: job.billed,
					relay: job.relay ?? false,
				}),
			),
			changedPaths: [...(run.changedPaths ?? [])],
			title: run.title,
		}),
	);
}

/** One relay input's value, or undefined when the workflow did not set it. */
export function relayJobInput(
	message: RelayJobMessage,
	name: RelayJobInputName,
): string | undefined {
	return message.inputs.find((input) => input.name === name)?.value;
}

/**
 * The walk's question for a relay job: the run's facts, and the labels each
 * runner type input names. `size` and `first` are not runner types and are
 * left out; an empty input means the type was not named.
 */
export function relayRouteRequest(
	message: RelayJobMessage,
): RunnerRouteRequest {
	return create(RunnerRouteRequestSchema, {
		repository: message.repository,
		private: message.private,
		fork: message.fork,
		event: message.event,
		runId: message.runId,
		runAttempt: message.runAttempt,
		job: message.job,
		inputs: message.inputs.flatMap((input) => {
			const key = runnerStepKey(input.name);
			const labels = relayInputLabels(input.value);
			return key && labels.length > 0 ? [{ key, labels: [...labels] }] : [];
		}),
		actorId: message.actorId,
		triggeringActorId: message.triggeringActorId,
		workflowRef: message.workflowRef,
	});
}

/** Whether a step is a HoBo check step: its `uses:` path ends in a check's name. */
export function isRelayCheckStep(uses: string): boolean {
	const path = uses.split("@")[0] ?? "";
	return RELAY_CHECK_STEP_SUFFIXES.some((suffix) => path.endsWith(suffix));
}
