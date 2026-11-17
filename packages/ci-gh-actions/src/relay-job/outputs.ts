/**
 * What the job-mode relay job writes for GitHub (ADR-0183): workflow
 * commands on standard output, and the job's outputs in the file
 * `GITHUB_OUTPUT` names.
 *
 * - Each decision is one `hobo-ci-relay` notice whose message is the
 *   journal entry as protobuf JSON, so a monitor or the parity scorecard can
 *   read it back from the run's annotations. `NoticeRouteJournal` is the
 *   `RouteJournal` that prints it; job mode keeps no other history.
 * - The answer's annotations print as `hobo-ci-relay-answer` errors,
 *   warnings and notices. A failed answer's error is the one sentence that
 *   says why nothing could run the job.
 * - The four outputs (`runner`, `step`, `outcome`, `reason`) are written in
 *   GitHub's multi-line form, so a value is never read as another line.
 *
 * Escaping follows the runner's workflow-command parser
 * (`actions/runner`, `src/Runner.Common/ActionCommand.cs`, which unescapes
 * `%25`, `%0D`, `%0A` in data and also `%3A`, `%2C` in properties), read on
 * 2026-11-17.
 *
 * Pure apart from the journal's `print`: no clock, network or store.
 */
import { toJsonString } from "@bufbuild/protobuf";
import {
	defineRunnerRouteEvent,
	type RelayJobAnswer,
	type RouteDecisionQuery,
	type RouteJournal,
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
} from "@hobo/ci";

// public-contract: the title of the notice holding one job-mode route decision.
export const RELAY_DECISION_NOTICE_TITLE = "hobo-ci-relay";
// public-contract: the title of the annotations a job-mode relay answer prints.
export const RELAY_ANSWER_ANNOTATION_TITLE = "hobo-ci-relay-answer";

/** A workflow command's level. */
export type WorkflowCommandLevel = "error" | "warning" | "notice";

/** A command's message, escaped as the runner unescapes it. */
export function escapeCommandData(text: string): string {
	return text
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
}

/** A command property's value, escaped as the runner unescapes it. */
export function escapeCommandProperty(text: string): string {
	return escapeCommandData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** One annotation line: `::error title=…::message`. */
export function workflowCommand(
	level: WorkflowCommandLevel,
	title: string,
	message: string,
): string {
	return `::${level} title=${escapeCommandProperty(title)}::${escapeCommandData(message)}`;
}

/** The lines an answer's annotations print, in order. */
export function answerAnnotationLines(
	answer: RelayJobAnswer,
): readonly string[] {
	return answer.annotations.map((note) =>
		workflowCommand(
			note.level === "error" || note.level === "warning"
				? note.level
				: "notice",
			RELAY_ANSWER_ANNOTATION_TITLE,
			note.message,
		),
	);
}

/** One output to write: its name and value. */
export type JobOutput = Readonly<{ name: string; value: string }>;

/**
 * The text appended to `GITHUB_OUTPUT` for these outputs, each in the
 * `name<<delimiter` form. Throws when a value holds the delimiter, which a
 * random delimiter makes impossible in practice.
 */
export function outputFileText(
	outputs: readonly JobOutput[],
	delimiter: string,
): string {
	if (!/^[A-Za-z0-9_-]{16,}$/u.test(delimiter))
		throw new Error("an output delimiter is at least 16 letters or digits");
	return outputs
		.map((output) => {
			if (output.value.includes(delimiter))
				throw new Error(`output ${output.name} holds the delimiter`);
			return `${output.name}<<${delimiter}\n${output.value}\n${delimiter}\n`;
		})
		.join("");
}

/** The notice a decision prints: the journal entry as protobuf JSON. */
export function decisionNoticeLine(event: RunnerRouteEvent): string {
	return workflowCommand(
		"notice",
		RELAY_DECISION_NOTICE_TITLE,
		toJsonString(RunnerRouteEventSchema, event),
	);
}

function journalKey(event: RunnerRouteEvent): string | undefined {
	return event.jobId === "" ? undefined : `${event.jobId}\u0000${event.type}`;
}

/**
 * The job-mode route journal: entries are kept for this one process, and each
 * `runner.route.Decided` is printed once as a `hobo-ci-relay` notice. The run's
 * annotations are the only history job mode has.
 */
export class NoticeRouteJournal implements RouteJournal {
	private readonly kept: RunnerRouteEvent[] = [];

	constructor(private readonly print: (line: string) => void) {}

	async record(event: RunnerRouteEvent): Promise<void> {
		const parsed = defineRunnerRouteEvent(event);
		const key = journalKey(parsed);
		if (key !== undefined && this.kept.some((kept) => journalKey(kept) === key))
			return;
		this.kept.push(parsed);
		if (parsed.type === "runner.route.Decided")
			this.print(decisionNoticeLine(parsed));
	}

	async decisions(
		query: RouteDecisionQuery,
	): Promise<readonly RunnerRouteEvent[]> {
		const repository = query.repository?.toLowerCase();
		return this.kept
			.map((event, index) => ({ event, index }))
			.filter(
				({ event }) =>
					event.accountId === query.accountId &&
					event.atMs >= query.sinceMs &&
					(repository === undefined ||
						event.request?.repository.toLowerCase() === repository),
			)
			.sort(
				(left, right) =>
					right.event.atMs - left.event.atMs || right.index - left.index,
			)
			.slice(0, Math.max(0, query.limit))
			.map(({ event }) => event);
	}
}
