import type { HttpTransport, TransportResponse } from "@hobo/core";
import { createProviderRedactor } from "@hobo/provider-redaction";
import { z } from "zod";
import {
	type Agent37CreateInstanceInput,
	type Agent37ExecInput,
	type Agent37ExecResult,
	type Agent37Instance,
	type Agent37RegisteredWebhook,
	type Agent37Usage,
	type Agent37UsageQuery,
	type Agent37Webhook,
	agent37CreateInstanceInputSchema,
	agent37DeletedSchema,
	agent37ErrorEnvelopeSchema,
	agent37ExecInputSchema,
	agent37ExecResultSchema,
	agent37InstanceListSchema,
	agent37InstanceSchema,
	agent37RegisteredWebhookSchema,
	agent37UsageQuerySchema,
	agent37UsageSchema,
	agent37WebhookListSchema,
	agent37WebhookUrlSchema,
} from "./contracts.js";
import {
	AGENT37_API_ORIGIN,
	AGENT37_EXEC_ORIGIN,
	AGENT37_MAX_RESPONSE_BYTES,
	AGENT37_MAX_TIMEOUT_MS,
	type Agent37TransportOptions,
	agent37RetryAfterMs,
	createAgent37Transport,
} from "./transport.js";

const redact = createProviderRedactor({
	patterns: [
		/(?<![A-Za-z0-9_-])sk_live_[A-Za-z0-9_-]+/g,
		/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g,
	],
	decodePercent: true,
});

export function redactAgent37Text(text: string, maxLength = 256): string {
	return redact(text, maxLength);
}

export type Agent37ErrorOptions = {
	readonly status?: number;
	readonly providerCode?: string;
	readonly retryAfterMs?: number;
	readonly retryable?: boolean;
};
type Agent37ErrorOptionsDraft = {
	-readonly [Key in keyof Agent37ErrorOptions]: Agent37ErrorOptions[Key];
};

type Agent37ErrorJson = {
	name: string;
	message: string;
	status?: number;
	providerCode?: string;
	retryAfterMs?: number;
	retryable: boolean;
};

export class Agent37Error extends Error {
	readonly status?: number;
	readonly providerCode?: string;
	readonly retryAfterMs?: number;
	readonly retryable: boolean;

	constructor(message: string, options: Agent37ErrorOptions = {}) {
		super(redactAgent37Text(message));
		this.name = "Agent37Error";
		if (options.status !== undefined) this.status = options.status;
		if (options.providerCode !== undefined) {
			this.providerCode = redactAgent37Text(options.providerCode, 80);
		}
		if (options.retryAfterMs !== undefined) {
			this.retryAfterMs = options.retryAfterMs;
		}
		this.retryable = options.retryable ?? false;
	}

	toJSON(): Agent37ErrorJson {
		const json: Agent37ErrorJson = {
			name: this.name,
			message: this.message,
			retryable: this.retryable,
		};
		if (this.status !== undefined) json.status = this.status;
		if (this.providerCode !== undefined) json.providerCode = this.providerCode;
		if (this.retryAfterMs !== undefined) json.retryAfterMs = this.retryAfterMs;
		return json;
	}
}

export type Agent37ClientOptions = Agent37TransportOptions & {
	readonly apiKey: string;
	readonly timeoutMs?: number;
};

export type Agent37Client = {
	createInstance(input: Agent37CreateInstanceInput): Promise<Agent37Instance>;
	getInstance(id: string): Promise<Agent37Instance>;
	listInstances(): Promise<readonly Agent37Instance[]>;
	deleteInstance(id: string): Promise<void>;
	exec(id: string, input: Agent37ExecInput): Promise<Agent37ExecResult>;
	registerWebhook(url: string): Promise<Agent37RegisteredWebhook>;
	listWebhooks(): Promise<readonly Agent37Webhook[]>;
	deleteWebhook(id: string): Promise<void>;
	usage(query?: Agent37UsageQuery): Promise<Agent37Usage>;
};

type RequestMethod = "GET" | "HEAD" | "POST" | "DELETE";
type RequestOptions<T> = {
	readonly method: RequestMethod;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly expected: readonly number[];
	readonly timeoutMs: number;
	readonly body?: unknown;
	readonly idempotent?: boolean;
	readonly responseSchema?: z.ZodType<T>;
	readonly responseSchemaForStatus?: (status: number) => z.ZodType<T>;
};

function parseInput<T>(schema: z.ZodType<T>, input: T): T {
	const parsed = schema.safeParse(input);
	if (parsed.success) return parsed.data;
	throw new Agent37Error("Agent37 request input did not match its contract");
}

function parseFailureDetails(error: z.ZodError): string {
	return error.issues
		.slice(0, 12)
		.map((issue) => `${issue.path.join(".") || "response"}:${issue.code}`)
		.join(", ");
}

function responseError(
	response: TransportResponse,
	now: number,
	method: RequestMethod,
	idempotent: boolean,
): Agent37Error {
	let providerCode: string | undefined;
	try {
		const parsed = agent37ErrorEnvelopeSchema.safeParse(
			JSON.parse(response.body),
		);
		if (parsed.success) providerCode = parsed.data.code;
	} catch {}
	const retryAfterMs = agent37RetryAfterMs(response, now);
	const safeMethod = method === "GET" || method === "HEAD";
	const retryableResponse =
		(response.status >= 500 && response.status <= 599) ||
		providerCode === "no_capacity" ||
		providerCode === "try_again";
	const errorOptions: Agent37ErrorOptionsDraft = {
		status: response.status,
		retryable: (safeMethod || idempotent) && retryableResponse,
	};
	if (providerCode !== undefined) errorOptions.providerCode = providerCode;
	if (retryAfterMs !== undefined) errorOptions.retryAfterMs = retryAfterMs;
	return new Agent37Error(
		`Agent37 returned ${response.status}${providerCode === undefined ? "" : ` ${providerCode}`}: ${response.body}`,
		errorOptions,
	);
}

function parseApiKey(value: string): string {
	if (!/^sk_live_[A-Za-z0-9_-]{8,248}$/u.test(value)) {
		throw new Agent37Error("Agent37 API key has an invalid shape");
	}
	return value;
}

export const AGENT37_API_KEY_REF = "owner://AGENT37_API_KEY";
const AGENT37_CREDENTIAL_SCOPE = "provider-agent37";

export type Agent37CredentialResolver = {
	resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>>;
};

export type Agent37ResolvedClientOptions = Omit<
	Agent37ClientOptions,
	"apiKey"
> & {
	readonly credentials: Agent37CredentialResolver;
};

export async function createAgent37ClientFromCredentials(
	options: Agent37ResolvedClientOptions,
): Promise<Agent37Client> {
	const { credentials, ...rest } = options;
	const material = await credentials.resolve(
		AGENT37_API_KEY_REF,
		AGENT37_CREDENTIAL_SCOPE,
	);
	const apiKey = material.token;
	if (apiKey === undefined || apiKey === "") {
		throw new Agent37Error(
			`Agent37 needs ${AGENT37_API_KEY_REF} from the owner's store session`,
		);
	}
	return createAgent37Client({ ...rest, apiKey });
}

export function createAgent37Client(
	options: Agent37ClientOptions,
): Agent37Client {
	const apiKey = parseApiKey(options.apiKey);
	const transport: HttpTransport = createAgent37Transport(options);
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? 20_000;

	async function request<T>(input: RequestOptions<T>): Promise<T> {
		let response: TransportResponse;
		try {
			const transportRequest = {
				method: input.method,
				url: input.url,
				headers: input.headers,
				timeoutMs: input.timeoutMs,
				maxResponseBytes: AGENT37_MAX_RESPONSE_BYTES,
			};
			response =
				input.body === undefined
					? await transport(transportRequest)
					: await transport({
							...transportRequest,
							body: JSON.stringify(input.body),
						});
		} catch (error) {
			throw new Agent37Error(
				`Agent37 ${input.method} request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!input.expected.includes(response.status)) {
			throw responseError(
				response,
				now(),
				input.method,
				input.idempotent ?? false,
			);
		}
		let json: unknown;
		try {
			json =
				response.body.trim() === "" ? undefined : JSON.parse(response.body);
		} catch {
			throw new Agent37Error(
				`Agent37 returned malformed JSON: ${response.body}`,
				{ status: response.status },
			);
		}
		const schema =
			input.responseSchemaForStatus === undefined
				? input.responseSchema
				: input.responseSchemaForStatus(response.status);
		if (schema === undefined) {
			throw new Agent37Error("Agent37 response schema is not configured");
		}
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			throw new Agent37Error(
				`Agent37 response did not match its contract: ${parseFailureDetails(parsed.error)}`,
				{ status: response.status },
			);
		}
		return parsed.data;
	}

	const apiHeaders = {
		accept: "application/json",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	};
	const execHeaders = {
		accept: "application/json",
		"x-agent37-key": apiKey,
		"content-type": "application/json",
	};
	const apiUrl = (path: string) => `${AGENT37_API_ORIGIN}${path}`;
	const resourceId = (id: string) => encodeURIComponent(id);

	return {
		createInstance(input) {
			const body = parseInput(agent37CreateInstanceInputSchema, input);
			return request({
				method: "POST",
				url: apiUrl("/v1/instances"),
				headers: apiHeaders,
				expected: [201],
				responseSchema: agent37InstanceSchema,
				body,
				timeoutMs: AGENT37_MAX_TIMEOUT_MS,
			});
		},
		getInstance(id) {
			return request({
				method: "GET",
				url: apiUrl(`/v1/instances/${resourceId(id)}`),
				headers: apiHeaders,
				expected: [200],
				responseSchema: agent37InstanceSchema,
				timeoutMs,
			});
		},
		listInstances() {
			return request({
				method: "GET",
				url: apiUrl("/v1/instances"),
				headers: apiHeaders,
				expected: [200],
				responseSchema: agent37InstanceListSchema,
				timeoutMs,
			});
		},
		async deleteInstance(id) {
			await request({
				method: "DELETE",
				url: apiUrl(`/v1/instances/${resourceId(id)}`),
				headers: apiHeaders,
				expected: [200, 204],
				responseSchemaForStatus: (status) =>
					status === 204 ? z.undefined() : agent37DeletedSchema,
				timeoutMs,
			});
		},
		exec(id, input) {
			const body = parseInput(agent37ExecInputSchema, input);
			return request({
				method: "POST",
				url: `${AGENT37_EXEC_ORIGIN}/v1/instances/${resourceId(id)}/exec`,
				headers: execHeaders,
				expected: [200],
				responseSchema: agent37ExecResultSchema,
				body,
				timeoutMs: AGENT37_MAX_TIMEOUT_MS,
				idempotent: body.name !== undefined,
			});
		},
		registerWebhook(url) {
			const webhookUrl = parseInput(agent37WebhookUrlSchema, url);
			return request({
				method: "POST",
				url: apiUrl("/v1/webhooks"),
				headers: apiHeaders,
				expected: [201],
				responseSchema: agent37RegisteredWebhookSchema,
				body: { url: webhookUrl },
				timeoutMs,
			});
		},
		listWebhooks() {
			return request({
				method: "GET",
				url: apiUrl("/v1/webhooks"),
				headers: apiHeaders,
				expected: [200],
				responseSchema: agent37WebhookListSchema,
				timeoutMs,
			});
		},
		async deleteWebhook(id) {
			await request({
				method: "DELETE",
				url: apiUrl(`/v1/webhooks/${resourceId(id)}`),
				headers: apiHeaders,
				expected: [200, 204],
				responseSchemaForStatus: (status) =>
					status === 204 ? z.undefined() : agent37DeletedSchema,
				timeoutMs,
			});
		},
		usage(query = {}) {
			const parsed = parseInput(agent37UsageQuerySchema, query);
			const search = new URLSearchParams();
			if (parsed.from !== undefined) search.set("from", parsed.from);
			if (parsed.to !== undefined) search.set("to", parsed.to);
			const suffix = search.size === 0 ? "" : `?${search.toString()}`;
			return request({
				method: "GET",
				url: apiUrl(`/v1/usage${suffix}`),
				headers: apiHeaders,
				expected: [200],
				responseSchema: agent37UsageSchema,
				timeoutMs,
			});
		},
	};
}

export type {
	Agent37CreateInstanceInput,
	Agent37ExecInput,
	Agent37ExecResult,
	Agent37Instance,
	Agent37RegisteredWebhook,
	Agent37Usage,
	Agent37UsageQuery,
	Agent37Webhook,
};
