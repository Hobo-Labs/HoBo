/**
 * The one function both relay modes call to answer a relay job (ADR-0183).
 *
 * Job mode calls it with facts read from GitHub and writes the answer to the
 * job's outputs. Relay mode calls it with the relay's own facts and completes
 * the job through a runner session. Either way the same engine decides.
 *
 * In order it: lets a check handler take a job made only of check steps;
 * journals the request; asks the order source and refuses a broken order with
 * the parser's sentence; reads the job's own `size` and `first`; gathers
 * facts; walks the order; journals the decision; and maps it to an answer.
 * `routed` and `waiting` succeed with a `runner` output. `none` fails, with
 * the reason as an error annotation, so the job behind the relay is skipped
 * instead of queued for a runner that will never come.
 *
 * It reads no clock: `nowMs` is given.
 */
import { clone, create } from "@bufbuild/protobuf";
import {
	type RelayJobAnnotation,
	type RelayJobAnswer,
	RelayJobAnswerSchema,
	type RelayJobMessage,
	RelayJobMessageSchema,
	type RelayJobValue,
	RelayJobValueSchema,
	RunnerRouteEventSchema,
} from "../_generated/relay_job_pb.js";
import {
	RunnerOrderSchema,
	type RunnerRouteDecision,
	RunnerRouteDecisionSchema,
	type RunnerRouteRequest,
} from "../_generated/runner_route_pb.js";
import { decideRunnerRoute, describeDecision } from "./decide.js";
import { defineRunnerOrder, type ParsedRunnerOrder } from "./order.js";
import type {
	RelayChecks,
	RouteFactsSource,
	RouteJournal,
	RunnerOrderSource,
} from "./ports.js";
import {
	RUNNER_AUTO_SIZES,
	RUNNER_STEP_KEYS,
	type RunnerStepKey,
	runnerAutoSize,
	runnerStepKey,
} from "./providers.js";
import {
	defineRelayJobAnswer,
	defineRelayJobMessage,
	defineRunnerRouteEvent,
	isRelayCheckStep,
	type ParsedRelayRecord,
	type RelayJobOutputName,
	type RelayMode,
	RelayRecordRejection,
	relayJobInput,
	relayRouteRequest,
} from "./relay-job.js";

export type AnswerRelayJobDeps = Readonly<{
	order: RunnerOrderSource;
	facts: RouteFactsSource;
	journal: RouteJournal;
	nowMs: number;
	mode: RelayMode;
	/** The node answering: a relay's name, or the job-mode evaluator's. */
	node: string;
	/** The HoBo account the journal entries belong to. */
	accountId: string;
	/** Answers check jobs; a check no handler answers fails closed. */
	checks: RelayChecks | undefined;
}>;

/** The git ref of a workflow ref (`owner/repo/path@ref`), or undefined when it names none. */
export function workflowGitRef(workflowRef: string): string | undefined {
	const at = workflowRef.lastIndexOf("@");
	const ref = at < 0 ? "" : workflowRef.slice(at + 1);
	return ref.length > 0 ? ref : undefined;
}

type JobChoices =
	| Readonly<{
			ok: true;
			size: number | undefined;
			first: RunnerStepKey | undefined;
	  }>
	| Readonly<{ ok: false; problem: string }>;

/** The job's own `size` and `first`, or the sentence saying why one cannot be read. */
function jobChoices(message: RelayJobMessage): JobChoices {
	const sizeText = relayJobInput(message, "size")?.trim() ?? "";
	const firstText = relayJobInput(message, "first")?.trim() ?? "";
	const size = sizeText === "" ? undefined : runnerAutoSize(Number(sizeText));
	if (sizeText !== "" && size === undefined)
		return {
			ok: false,
			problem: `the relay input size is ${RUNNER_AUTO_SIZES.slice(0, -1).join(", ")} or ${RUNNER_AUTO_SIZES.at(-1)} vCPUs, not "${sizeText}"`,
		};
	const first = firstText === "" ? undefined : runnerStepKey(firstText);
	if (firstText !== "" && first === undefined)
		return {
			ok: false,
			problem: `the relay input first names a runner type (${RUNNER_STEP_KEYS.join(", ")}), not "${firstText}"`,
		};
	return { ok: true, size, first };
}

function sized(
	order: ParsedRunnerOrder,
	size: number | undefined,
): ParsedRunnerOrder {
	if (size === undefined) return order;
	return defineRunnerOrder(
		create(RunnerOrderSchema, {
			...clone(RunnerOrderSchema, order),
			autoSizeVcpus: size,
		}),
	);
}

function output(name: RelayJobOutputName, value: string): RelayJobValue {
	return create(RelayJobValueSchema, { name, value });
}

function annotationsFor(
	decision: RunnerRouteDecision,
): readonly Pick<RelayJobAnnotation, "level" | "message">[] {
	const text = describeDecision(decision);
	if (decision.outcome === "none") return [{ level: "error", message: text }];
	if (decision.outcome === "waiting")
		return [{ level: "notice", message: text }];
	return decision.unhealthyFallback
		? [{ level: "warning", message: text }]
		: [];
}

function answerFor(
	message: RelayJobMessage,
	decision: RunnerRouteDecision,
): ParsedRelayRecord<RelayJobAnswer> {
	return defineRelayJobAnswer(
		create(RelayJobAnswerSchema, {
			jobId: message.jobId,
			planId: message.planId,
			conclusion: decision.outcome === "none" ? "failed" : "succeeded",
			outputs: [
				output("runner", decision.runner),
				output("step", decision.step),
				output("outcome", decision.outcome),
				output("reason", describeDecision(decision)),
			],
			annotations: [...annotationsFor(decision)],
		}),
	);
}

function refusal(reason: string): RunnerRouteDecision {
	return create(RunnerRouteDecisionSchema, { outcome: "none", reason });
}

/** Read the message without touching the caller's copy, or say why it cannot be read. */
function readMessage(
	message: RelayJobMessage,
):
	| Readonly<{ ok: true; message: ParsedRelayRecord<RelayJobMessage> }>
	| Readonly<{ ok: false; problem: string }> {
	try {
		return {
			ok: true,
			message: defineRelayJobMessage(clone(RelayJobMessageSchema, message)),
		};
	} catch (error) {
		if (
			error instanceof RelayRecordRejection &&
			message.jobId !== "" &&
			message.planId !== ""
		)
			return {
				ok: false,
				problem: `The relay job could not be read: ${error.message}`,
			};
		throw error;
	}
}

/**
 * Answer one relay job. Throws only when the message has no job or plan id,
 * since then there is nothing to complete.
 */
export async function answerRelayJob(
	message: RelayJobMessage,
	deps: AnswerRelayJobDeps,
): Promise<ParsedRelayRecord<RelayJobAnswer>> {
	const parsed = readMessage(message);
	if (!parsed.ok) return answerFor(message, refusal(parsed.problem));
	const read = parsed.message;
	if (deps.checks) {
		const checked = await deps.checks(read);
		if (checked)
			return defineRelayJobAnswer(clone(RelayJobAnswerSchema, checked));
	}
	if (read.steps.some((step) => isRelayCheckStep(step.uses)))
		return answerFor(
			read,
			refusal(
				"No relay check handler answered this job; its checks did not run.",
			),
		);
	const request = relayRouteRequest(read);
	await journal(deps, read, request, undefined);
	const decision = await decide(read, request, deps);
	await journal(deps, read, request, decision);
	return answerFor(read, decision);
}

async function decide(
	message: RelayJobMessage,
	request: RunnerRouteRequest,
	deps: AnswerRelayJobDeps,
): Promise<RunnerRouteDecision> {
	const lookup = await deps.order.order(
		message.repository,
		workflowGitRef(message.workflowRef),
	);
	if (lookup.problem !== "") return refusal(lookup.problem);
	const choices = jobChoices(message);
	if (!choices.ok) return refusal(choices.problem);
	const facts = await deps.facts.facts(request, deps.nowMs);
	return decideRunnerRoute(sized(lookup.order, choices.size), request, {
		...facts,
		first: choices.first ?? facts.first,
	});
}

async function journal(
	deps: AnswerRelayJobDeps,
	message: RelayJobMessage,
	request: RunnerRouteRequest,
	decision: RunnerRouteDecision | undefined,
): Promise<void> {
	await deps.journal.record(
		defineRunnerRouteEvent(
			create(RunnerRouteEventSchema, {
				type: decision ? "runner.route.Decided" : "runner.route.Requested",
				accountId: deps.accountId,
				atMs: deps.nowMs,
				request,
				decision,
				mode: deps.mode,
				node: deps.node,
				jobId: message.jobId,
			}),
		),
	);
}
