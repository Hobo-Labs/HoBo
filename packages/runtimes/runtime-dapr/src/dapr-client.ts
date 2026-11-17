import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

export interface DaprPublishRequest {
	readonly pubsubName: string;
	readonly topic: string;
	readonly data: JsonValue;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface DaprInvokeActorRequest {
	readonly actorType: string;
	readonly actorId: string;
	readonly method: string;
	readonly data?: JsonValue;
}

export interface DaprInvokeResult {
	readonly fenceToken?: string;
	readonly holderId?: string;
	readonly released?: boolean;
	readonly ok?: boolean;
	readonly method?: string;
	readonly key?: string;
}

export interface DaprStateRequest {
	readonly storeName: string;
	readonly key: string;
	readonly value?: JsonValue;
}

export interface DaprReminderRequest {
	readonly actorType: string;
	readonly actorId: string;
	readonly name: string;
	readonly dueTimeMs: number;
}

export interface DaprSidecarClient {
	readonly kind: "dapr-sidecar-client";
	readonly fidelity?: "simulated" | "live";
	publish(request: DaprPublishRequest): Promise<{ id: string }>;
	drain(
		pubsubName: string,
		topic: string,
		maxMessages: number,
		consumerGroup?: string,
	): Promise<
		readonly {
			id: string;
			data: JsonValue;
			topic: string;
			deliveryAttempt: number;
		}[]
	>;
	ack(messageId: string, consumerGroup?: string): Promise<void>;
	nack(messageId: string, consumerGroup?: string): Promise<void>;
	invokeActor(request: DaprInvokeActorRequest): Promise<DaprInvokeResult>;
	saveState(request: DaprStateRequest & { value: JsonValue }): Promise<void>;
	getState(request: DaprStateRequest): Promise<JsonValue>;
	registerReminder(
		request: DaprReminderRequest,
	): Promise<{ reminderId: string }>;
	health?(): Promise<boolean>;
}

export interface InMemoryDaprClientOptions {
	readonly now?: () => string;
}

interface StoredPub {
	id: string;
	pubsubName: string;
	topic: string;
	data: JsonValue;
}

interface GroupCursor {
	acked: Set<string>;
	inflight: Set<string>;
	attempts: Map<string, number>;
}

export function createInMemoryDaprClient(
	options: InMemoryDaprClientOptions = {},
): DaprSidecarClient {
	void options;
	const pubs: StoredPub[] = [];
	const groups = new Map<string, GroupCursor>();
	const state = new Map<string, JsonValue>();
	const actors = new Map<string, { holder?: string; fence: bigint }>();
	let seq = 0;
	let reminderSeq = 0;

	const cursorFor = (group: string): GroupCursor => {
		let g = groups.get(group);
		if (!g) {
			g = { acked: new Set(), inflight: new Set(), attempts: new Map() };
			groups.set(group, g);
		}
		return g;
	};

	const client: DaprSidecarClient = {
		kind: "dapr-sidecar-client",
		fidelity: "simulated",

		async publish(request) {
			const id = `dapr-msg-${++seq}`;
			pubs.push({
				id,
				pubsubName: request.pubsubName,
				topic: request.topic,
				data: request.data,
			});
			return { id };
		},

		async drain(pubsubName, topic, maxMessages, consumerGroup = "default") {
			const cursor = cursorFor(consumerGroup);
			const out: {
				id: string;
				data: JsonValue;
				topic: string;
				deliveryAttempt: number;
			}[] = [];
			for (const msg of pubs) {
				if (out.length >= maxMessages) break;
				if (msg.pubsubName !== pubsubName || msg.topic !== topic) continue;
				if (cursor.acked.has(msg.id) || cursor.inflight.has(msg.id)) continue;
				const attempt = (cursor.attempts.get(msg.id) ?? 0) + 1;
				cursor.attempts.set(msg.id, attempt);
				cursor.inflight.add(msg.id);
				out.push({
					id: msg.id,
					data: msg.data,
					topic: msg.topic,
					deliveryAttempt: attempt,
				});
			}
			return out;
		},

		async ack(messageId, consumerGroup = "default") {
			const cursor = cursorFor(consumerGroup);
			if (!pubs.some((m) => m.id === messageId)) {
				throw new Error(`dapr client: unknown message ${messageId}`);
			}
			cursor.acked.add(messageId);
			cursor.inflight.delete(messageId);
		},

		async nack(messageId, consumerGroup = "default") {
			const cursor = cursorFor(consumerGroup);
			if (!pubs.some((m) => m.id === messageId)) {
				throw new Error(`dapr client: unknown message ${messageId}`);
			}
			cursor.inflight.delete(messageId);
		},

		async invokeActor(request) {
			const key = `${request.actorType}/${request.actorId}`;
			const current = actors.get(key) ?? { fence: 0n };
			if (request.method === "acquire") {
				const holderId = isJsonObject(request.data)
					? request.data.holderId
					: undefined;
				const holder = isJsonString(holderId) ? holderId : "unknown";
				const next = { holder, fence: current.fence + 1n };
				actors.set(key, next);
				return { fenceToken: next.fence.toString(), holderId: holder };
			}
			if (request.method === "release") {
				actors.set(key, { fence: current.fence });
				return { released: true };
			}
			return { ok: true, method: request.method, key };
		},

		async saveState(request) {
			state.set(`${request.storeName}::${request.key}`, request.value ?? null);
		},

		async getState(request) {
			return state.get(`${request.storeName}::${request.key}`) ?? null;
		},

		async registerReminder(request) {
			return {
				reminderId: `dapr-reminder-${++reminderSeq}:${request.name}:${request.dueTimeMs}`,
			};
		},

		async health() {
			return true;
		},
	};

	return Object.freeze(client);
}

export function resolveDaprClientFromEnv(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
	options: {
		readonly createLive?: (endpoint: string) => DaprSidecarClient;
	} = {},
): DaprSidecarClient | undefined {
	if (env.HOBO_DAPR_LIVE_CLIENT === "memory") {
		return createInMemoryDaprClient();
	}
	const endpoint =
		(isJsonString(env.HOBO_DAPR_ENDPOINT) && env.HOBO_DAPR_ENDPOINT) ||
		undefined;
	if (endpoint && options.createLive) {
		return options.createLive(endpoint);
	}
	return undefined;
}
