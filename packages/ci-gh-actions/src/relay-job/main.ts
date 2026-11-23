import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import {
	answerRelayJob,
	DEFAULT_RUNNER_ORDER,
	defineRelayJobMessage,
	type ParsedRelayRecord,
	RELAY_JOB_INPUTS,
	RELAY_JOB_OUTPUTS,
	type RelayJobAnswer,
	type RelayJobInputName,
	type RelayJobMessage,
	RelayJobMessageSchema,
	type RunnerOrderLookup,
	type RunnerOrderSource,
} from "@hobo/ci";
import { z } from "zod";
import { parseCiRunnerOrder } from "../runner-order-config.js";
import { parseRunnerRouting, runnerRoutingLabels } from "../runner-routing.js";
import {
	GITHUB_API_URL,
	GITHUB_FACTS_WARNING_TITLE,
	GithubRouteFacts,
} from "./github-facts.js";
import {
	answerAnnotationLines,
	NoticeRouteJournal,
	outputFileText,
	RELAY_ANSWER_ANNOTATION_TITLE,
	workflowCommand,
} from "./outputs.js";
import type { QueueLimits } from "./queue-evidence.js";

// public-contract: the node name job-mode journal entries carry.
export const RELAY_JOB_NODE = "hobo-relay-job";
// public-contract: where the evaluator reads the committed project file.
export const RELAY_JOB_PROJECT_FILE = ".hobo/ci.json";

export const RELAY_JOB_CONTEXT_ARGUMENTS = [
	"repository",
	"run-id",
	"run-attempt",
	"job",
	"job-id",
	"event",
	"actor-id",
	"triggering-actor-id",
	"private",
	"fork",
	"workflow-ref",
] as const;
type ContextArgument = (typeof RELAY_JOB_CONTEXT_ARGUMENTS)[number];

export type RepositoryPrivacy = "true" | "false" | "unknown";

export type RelayJobArguments = Readonly<{
	inputs: readonly (readonly [RelayJobInputName, string])[];
	repository: string;
	runId: number;
	runAttempt: number;
	job: string;
	jobId: string;
	event: string;
	actorId: string;
	triggeringActorId: string;
	private: RepositoryPrivacy;
	fork: boolean;
	workflowRef: string;
}>;

type Parsed<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; problem: string }>;

function isInputName(name: string): name is RelayJobInputName {
	return RELAY_JOB_INPUTS.some((input) => input === name);
}

function isContextName(name: string): name is ContextArgument {
	return RELAY_JOB_CONTEXT_ARGUMENTS.some((argument) => argument === name);
}

const WHOLE = /^[1-9][0-9]{0,15}$/u;

export function parseRelayJobArguments(
	argv: readonly string[],
): Parsed<RelayJobArguments> {
	const inputs = new Map<RelayJobInputName, string>();
	const context = new Map<ContextArgument, string>();
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index] ?? "";
		const value = argv[index + 1];
		const name = flag.startsWith("--") ? flag.slice(2) : "";
		if (value === undefined && (isInputName(name) || isContextName(name)))
			return { ok: false, problem: `argument ${flag} has no value` };
		if (seen.has(name))
			return { ok: false, problem: `argument ${flag} is given twice` };
		seen.add(name);
		const text = value?.trim() ?? "";
		if (isInputName(name)) inputs.set(name, text);
		else if (isContextName(name)) context.set(name, text);
		else return { ok: false, problem: `unknown argument "${flag}"` };
	}
	const get = (name: ContextArgument): string => context.get(name) ?? "";
	for (const name of ["repository", "run-id", "job", "event"] as const)
		if (get(name) === "")
			return { ok: false, problem: `argument --${name} is required` };
	const runIdText = get("run-id");
	const attemptText = get("run-attempt") === "" ? "1" : get("run-attempt");
	if (!WHOLE.test(runIdText))
		return { ok: false, problem: "--run-id is a run id" };
	if (!WHOLE.test(attemptText))
		return { ok: false, problem: "--run-attempt is a whole number" };
	const privacy = get("private") === "" ? "unknown" : get("private");
	if (privacy !== "true" && privacy !== "false" && privacy !== "unknown")
		return { ok: false, problem: "--private is true, false or unknown" };
	const fork = get("fork") === "" ? "false" : get("fork");
	if (fork !== "true" && fork !== "false")
		return { ok: false, problem: "--fork is true or false" };
	const runId = Number(runIdText);
	const runAttempt = Number(attemptText);
	const job = get("job");
	return {
		ok: true,
		value: {
			inputs: RELAY_JOB_INPUTS.flatMap(
				(name): (readonly [RelayJobInputName, string])[] => {
					const value = inputs.get(name) ?? "";
					return value === "" ? [] : [[name, value]];
				},
			),
			repository: get("repository"),
			runId,
			runAttempt,
			job,
			jobId:
				get("job-id") === "" ? `${runId}-${runAttempt}-${job}` : get("job-id"),
			event: get("event"),
			actorId: get("actor-id"),
			triggeringActorId: get("triggering-actor-id"),
			private: privacy,
			fork: fork === "true",
			workflowRef: get("workflow-ref"),
		},
	};
}

export function relayJobMessageOf(
	args: RelayJobArguments,
	isPrivate: boolean,
): ParsedRelayRecord<RelayJobMessage> {
	return defineRelayJobMessage(
		create(RelayJobMessageSchema, {
			jobId: args.jobId,
			planId: String(args.runId),
			repository: args.repository,
			runId: args.runId,
			runAttempt: args.runAttempt,
			job: args.job,
			event: args.event,
			actorId: args.actorId,
			triggeringActorId: args.triggeringActorId,
			private: isPrivate,
			fork: args.fork,
			workflowRef: args.workflowRef,
			inputs: args.inputs.map(([name, value]) => ({ name, value })),
		}),
	);
}

export class CheckoutRunnerOrderSource implements RunnerOrderSource {
	constructor(
		private readonly read: (repository: string) => Promise<string | undefined>,
	) {}

	async order(
		repository: string,
		_ref: string | undefined,
	): Promise<RunnerOrderLookup> {
		const text = await this.read(repository);
		const committed = parseCiRunnerOrder(text ?? "{}");
		return {
			order: committed.order ?? DEFAULT_RUNNER_ORDER,
			problem:
				committed.problem === ""
					? ""
					: `${RELAY_JOB_PROJECT_FILE}: ${committed.problem}`,
		};
	}
}

const ProjectRouting = z.object({ runnerRouting: z.json().optional() });

type RoutingOptions = Readonly<{
	slipLabels: ReadonlySet<string> | undefined;
	limits: QueueLimits | undefined;
}>;

function routingOptions(text: string | undefined): RoutingOptions {
	if (text === undefined) return { slipLabels: undefined, limits: undefined };
	let routing: ReturnType<typeof parseRunnerRouting>;
	try {
		const document = ProjectRouting.safeParse(JSON.parse(text));
		routing = document.success
			? parseRunnerRouting(document.data.runnerRouting)
			: undefined;
	} catch {
		routing = undefined;
	}
	return routing
		? { slipLabels: runnerRoutingLabels(routing), limits: routing.queue }
		: { slipLabels: undefined, limits: undefined };
}

export type RelayJobIo = Readonly<{
	token: string;
	apiUrl: string;
	fetch: typeof fetch;
	readProjectFile: () => Promise<string | undefined>;
	nowMs: number;
	print: (line: string) => void;
	writeOutputs: (text: string) => Promise<void>;
	delimiter: string;
}>;

export type RelayJobRun = Readonly<{
	exitCode: number;
	answer: RelayJobAnswer | undefined;
}>;

const RepositoryBody = z.object({ private: z.boolean() });

async function repositoryIsPrivate(
	args: RelayJobArguments,
	io: RelayJobIo,
): Promise<boolean> {
	if (args.private !== "unknown") return args.private === "true";
	try {
		const response = await io.fetch(
			`${io.apiUrl.replace(/\/+$/u, "")}/repos/${args.repository}`,
			{
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${io.token}`,
					"x-github-api-version": "2022-11-28",
					"user-agent": "hobo-ci-relay",
				},
				signal: AbortSignal.timeout(5_000),
			},
		);
		const body = RepositoryBody.safeParse(
			response.status === 200 ? await response.json() : null,
		);
		if (body.success) return body.data.private;
	} catch {}
	io.print(
		workflowCommand(
			"warning",
			GITHUB_FACTS_WARNING_TITLE,
			"Whether the repository is private could not be read, so it is treated as public and its job does not run on a machine.",
		),
	);
	return false;
}

export async function runRelayJob(
	args: RelayJobArguments,
	io: RelayJobIo,
): Promise<RelayJobRun> {
	const project = await io.readProjectFile();
	const routing = routingOptions(project);
	const facts = new GithubRouteFacts({
		token: io.token,
		apiUrl: io.apiUrl,
		fetch: io.fetch,
		slipLabels: routing.slipLabels,
		limits: routing.limits,
	});
	const message = relayJobMessageOf(args, await repositoryIsPrivate(args, io));
	const answer = await answerRelayJob(message, {
		order: new CheckoutRunnerOrderSource(async () => project),
		facts,
		journal: new NoticeRouteJournal(io.print),
		nowMs: io.nowMs,
		mode: "job",
		node: RELAY_JOB_NODE,
		accountId: args.repository.split("/")[0] ?? args.repository,
		checks: undefined,
	});
	for (const warning of facts.warnings)
		io.print(workflowCommand("warning", warning.title, warning.message));
	for (const line of answerAnnotationLines(answer)) io.print(line);
	const outputs = RELAY_JOB_OUTPUTS.map((name) => ({
		name,
		value: answer.outputs.find((output) => output.name === name)?.value ?? "",
	}));
	await io.writeOutputs(outputFileText(outputs, io.delimiter));
	return {
		exitCode: answer.conclusion === "succeeded" ? 0 : 1,
		answer,
	};
}

export type RelayJobProcess = Readonly<{
	argv: readonly string[];
	env: ReadonlyMap<string, string>;
	print: (line: string) => void;
	fetch: typeof fetch;
	nowMs: number;
	cwd: string;
}>;

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
}

export async function runRelayJobCli(proc: RelayJobProcess): Promise<number> {
	const fail = (why: string): number => {
		proc.print(
			workflowCommand(
				"error",
				RELAY_ANSWER_ANNOTATION_TITLE,
				`The relay job could not answer: ${why}.`,
			),
		);
		return 1;
	};
	const parsed = parseRelayJobArguments(proc.argv);
	if (!parsed.ok) return fail(parsed.problem);
	const outputPath = proc.env.get("GITHUB_OUTPUT") ?? "";
	if (outputPath === "") return fail("GITHUB_OUTPUT is not set");
	try {
		const run = await runRelayJob(parsed.value, {
			token: proc.env.get("GITHUB_TOKEN") ?? "",
			apiUrl: proc.env.get("GITHUB_API_URL") || GITHUB_API_URL,
			fetch: proc.fetch,
			readProjectFile: () =>
				readOptional(`${proc.cwd}/${RELAY_JOB_PROJECT_FILE}`),
			nowMs: proc.nowMs,
			print: proc.print,
			writeOutputs: (text) => appendFile(outputPath, text, "utf8"),
			delimiter: `hobo_relay_${randomUUID().replaceAll("-", "")}`,
		});
		return run.exitCode;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}
