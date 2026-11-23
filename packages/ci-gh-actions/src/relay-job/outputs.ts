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

export type WorkflowCommandLevel = "error" | "warning" | "notice";

export function escapeCommandData(text: string): string {
	return text
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
}

export function escapeCommandProperty(text: string): string {
	return escapeCommandData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function workflowCommand(
	level: WorkflowCommandLevel,
	title: string,
	message: string,
): string {
	return `::${level} title=${escapeCommandProperty(title)}::${escapeCommandData(message)}`;
}

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

export type JobOutput = Readonly<{ name: string; value: string }>;

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
