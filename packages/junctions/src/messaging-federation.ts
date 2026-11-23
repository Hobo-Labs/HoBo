import type { JunctionDefinition } from "./types.js";

export const JUNCTION_MESSAGING_FEDERATED_EVENT =
	"messaging.federated" as const;

export interface TopicFederationLink {
	readonly kind: "topic-federation";
	readonly topicLogicalName: string;
	readonly fromYard: string;
	readonly toYard: string;
	readonly delivery: "at-least-once";
	readonly identityAudience: string;
	readonly connectivityEdgeId: string;
}

export interface ActorSignalFederationLink {
	readonly kind: "actor-signal-federation";
	readonly actorType: string;
	readonly fromYard: string;
	readonly toYard: string;
	readonly identityAudience: string;
}

export interface JunctionMessagingFederationPlan {
	readonly junctionName: string;
	readonly topics: readonly TopicFederationLink[];
	readonly actorSignals: readonly ActorSignalFederationLink[];
	readonly eventType: typeof JUNCTION_MESSAGING_FEDERATED_EVENT;
}

export interface DeriveMessagingFederationInput {
	readonly definition: JunctionDefinition;
	readonly topics?: readonly string[];
	readonly actorTypes?: readonly string[];
}

export function deriveMessagingFederationPlan(
	input: DeriveMessagingFederationInput,
): JunctionMessagingFederationPlan {
	const names = input.definition.members.map((m) => m.yardName);
	const topics: TopicFederationLink[] = [];
	const actorSignals: ActorSignalFederationLink[] = [];
	const topicNames = input.topics ?? [];
	const actorTypes = input.actorTypes ?? [];

	for (const fromYard of names) {
		for (const toYard of names) {
			if (fromYard === toYard) continue;
			const edgeId = `edge:${fromYard}->${toYard}`;
			for (const topic of topicNames) {
				topics.push({
					kind: "topic-federation",
					topicLogicalName: topic,
					fromYard,
					toYard,
					delivery: "at-least-once",
					identityAudience: `messaging:${input.definition.name}:${topic}`,
					connectivityEdgeId: edgeId,
				});
			}
			for (const actorType of actorTypes) {
				actorSignals.push({
					kind: "actor-signal-federation",
					actorType,
					fromYard,
					toYard,
					identityAudience: `actor-signal:${input.definition.name}:${actorType}`,
				});
			}
		}
	}

	return Object.freeze({
		junctionName: input.definition.name,
		topics: Object.freeze(topics),
		actorSignals: Object.freeze(actorSignals),
		eventType: JUNCTION_MESSAGING_FEDERATED_EVENT,
	});
}
