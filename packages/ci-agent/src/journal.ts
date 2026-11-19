import type { AgentEvent, Resolution } from "./_generated/agent_pb.js";

export const AGENT_EVENT_TYPES = [
	"ci.agent.PlanProposed",
	"ci.agent.ResolutionSettled",
	"ci.agent.ResolutionPublished",
	"ci.agent.RollupPublished",
	"ci.agent.EntryEnqueued",
	"ci.agent.BudgetExhausted",
	"ci.agent.ApplyWithheld",
	"ci.agent.ResolutionChecked",
	"ci.agent.EntryEjected",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const SETTLING_EVENT_TYPES: readonly string[] = [
	"ci.agent.ResolutionSettled",
	"ci.agent.RollupPublished",
];

export interface AgentJournal {
	append(event: AgentEvent): Promise<void>;
	has(key: string): Promise<boolean>;
	settled(key: string): Promise<Resolution | undefined>;
	tokensSince(since: string): Promise<number>;
	latest(
		repository: string,
		type: AgentEventType,
	): Promise<AgentEvent | undefined>;
	latestChecked(resolutionKey: string): Promise<AgentEvent | undefined>;
	recent(
		repository: string,
		type: AgentEventType,
		since: string,
	): Promise<readonly AgentEvent[]>;
	events(): Promise<readonly AgentEvent[]>;
}

export function eventKey(event: AgentEvent): string {
	if (SETTLING_EVENT_TYPES.includes(event.type))
		return event.resolution?.key ?? "";
	if (event.type === "ci.agent.ResolutionPublished")
		return publishedKey(event.resolution?.key ?? "");
	if (event.type === "ci.agent.EntryEnqueued")
		return enqueuedKey(event.repository, event.numbers[0] ?? 0, event.headSha);
	if (event.type === "ci.agent.EntryEjected")
		return ejectedKey(event.repository, event.numbers[0] ?? 0, event.headSha);
	if (event.type === "ci.agent.ResolutionChecked")
		return checkedKey(event.resolution?.key ?? "");
	return "";
}

export const publishedKey = (resolutionKey: string) =>
	`published:${resolutionKey}`;
export const enqueuedKey = (
	repository: string,
	number: number,
	headSha: string,
) => `enqueued:${repository}#${number}@${headSha}`;

export const ejectedKey = (
	repository: string,
	number: number,
	headSha: string,
) => `ejected:${repository}#${number}@${headSha}`;
export const checkedKey = (resolutionKey: string) => `checked:${resolutionKey}`;

export function eventTokens(event: AgentEvent): number {
	if (event.type !== "ci.agent.ResolutionSettled") return 0;
	const usage = event.resolution?.usage;
	return Number((usage?.inputTokens ?? 0n) + (usage?.outputTokens ?? 0n));
}

export function createMemoryJournal(): AgentJournal {
	const events: AgentEvent[] = [];
	return {
		async append(event) {
			if (events.some((existing) => existing.id === event.id)) return;
			events.push(event);
		},
		async has(key) {
			return key !== "" && events.some((event) => eventKey(event) === key);
		},
		async settled(key) {
			return events.find(
				(event) =>
					SETTLING_EVENT_TYPES.includes(event.type) &&
					event.resolution?.key === key,
			)?.resolution;
		},
		async tokensSince(since) {
			return events
				.filter((event) => event.at >= since)
				.reduce((total, event) => total + eventTokens(event), 0);
		},
		async latest(repository, type) {
			return events
				.filter(
					(event) => event.repository === repository && event.type === type,
				)
				.at(-1);
		},
		async latestChecked(resolutionKey) {
			const key = checkedKey(resolutionKey);
			return events.filter((event) => eventKey(event) === key).at(-1);
		},
		async recent(repository, type, since) {
			return events.filter(
				(event) =>
					event.repository === repository &&
					event.type === type &&
					event.at >= since,
			);
		},
		async events() {
			return [...events];
		},
	};
}
