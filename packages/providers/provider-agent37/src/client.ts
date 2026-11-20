import type { HttpTransport, TransportResponse } from "@hobo/core";
import { createProviderRedactor } from "@hobo/provider-redaction";
import { z } from "zod";
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
		if (options.providerCode !== undefined)
			this.providerCode = redactAgent37Text(options.providerCode, 80);
		if (options.retryAfterMs !== undefined)
			this.retryAfterMs = options.retryAfterMs;
		this.retryable = options.retryable ?? false;
	}

	toJSON() {
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

const instanceStatus = z.enum([
	"provisioning",
	"running",
	"stopping",
	"stopped",
	"starting",
	"restarting",
	"updating",
	"sleeping",
	"waking",
	"failed",
	"deleting",
	"deleted",
]);
const resources = z.object({
	cpu: z.number().int().positive(),
	memory: z.number().int().positive(),
	disk: z.number().int().positive(),
});
const network = z.union([
	z.literal("allow-all"),
	z.literal("deny-all"),
	z.object({ allow: z.array(z.string()).max(100) }),
]);
const publicPort = z.object({
	port: z.number().int().min(1).max(65_535),
	url: z.url().optional(),
	domain_urls: z.array(z.url()).optional(),
	prefix: z.string().nullable().optional(),
	label: z.string().nullable().optional(),
	created: z.number().int().optional(),
});
const instance = z.object({
	id: z.string().min(1),
	status: instanceStatus,
	status_reason: z.unknown().nullable().optional(),
	template: z.string().min(1),
	template_revision: z.number().int().nullable().optional(),
	image_ref: z.string().nullable().optional(),
	image_digest: z.string().nullable().optional(),
	type: z.enum(["default", "vm", "performance"]),
	region: z.enum(["us", "eu", "ap-south"]),
	mount_path: z.string().nullable().optional(),
	resources,
	url: z.url().optional(),
	domain_urls: z.array(z.url()).optional(),
	public_ports: z.array(z.union([z.number().int(), publicPort])),
	name: z.string().nullable().optional(),
	metadata: z.record(z.string(), z.string()).nullable().optional(),
	auto_sleep: z.boolean(),
	idle_timeout_seconds: z.number().int().min(300).max(86_400),
	network,
	sleeping: z.number().int().nullable().optional(),
	past_due: z.boolean().optional(),
	created: z.number().int().optional(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
});

export type Agent37Instance = z.infer<typeof instance>;

const createInstanceInput = z
	.object({
		template: z.string().min(1).optional(),
		resources: resources.strict().optional(),
		type: z.enum(["default", "vm", "performance"]).optional(),
		region: z.enum(["us", "eu", "ap-south"]).optional(),
		name: z.string().optional(),
		metadata: z.record(z.string(), z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
		budget: z
			.object({
				monthly_cap_micros: z.number().int().nonnegative(),
				credit_micros: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		auto_sleep: z.boolean().optional(),
		idle_timeout_seconds: z.number().int().min(300).max(86_400).optional(),
		public_ports: z
			.array(
				z
					.object({
						port: z.number().int().min(1).max(65_535),
						prefix: z.string().optional(),
						label: z.string().optional(),
					})
					.strict(),
			)
			.optional(),
		network: z
			.union([
				z.literal("allow-all"),
				z.literal("deny-all"),
				z.object({ allow: z.array(z.string()).max(100) }).strict(),
			])
			.optional(),
		mount_path: z.string().optional(),
	})
	.strict();
export type Agent37CreateInstanceInput = z.infer<typeof createInstanceInput>;

const instanceList = z
	.union([
		z.object({ data: z.array(instance) }),
		z.object({ instances: z.array(instance) }),
	])
	.transform((value) => ("data" in value ? value.data : value.instances));

const execInput = z.object({
	command: z.string().min(1).max(1_048_576),
	user: z.literal("root").optional(),
	background: z.boolean().optional(),
	name: z.string().min(1).max(128).optional(),
});
export type Agent37ExecInput = z.infer<typeof execInput>;

const execResult = z.union([
	z.object({ pid: z.number().int().positive() }),
	z.object({
		id: z.string().optional(),
		instance_id: z.string().optional(),
		background: z.boolean().optional(),
		status: z.string().optional(),
		exit_code: z.number().int().nullable(),
		stdout: z.string(),
		stderr: z.string(),
		truncated: z.boolean().optional(),
		created_at: z.string().optional(),
		finished_at: z.string().nullable().optional(),
	}),
]);
export type Agent37ExecResult = z.infer<typeof execResult>;

const webhook = z.object({
	id: z.string().min(1),
	url: z.url(),
	last_failure: z.unknown().nullable().optional(),
	created: z.number().int().optional(),
	created_at: z.string().optional(),
});
const registeredWebhook = webhook.extend({ secret: z.string().min(1) });
export type Agent37Webhook = z.infer<typeof webhook>;
export type Agent37RegisteredWebhook = z.infer<typeof registeredWebhook>;
const webhookList = z
	.union([
		z.object({ data: z.array(webhook) }),
		z.object({ webhooks: z.array(webhook) }),
	])
	.transform((value) => ("data" in value ? value.data : value.webhooks));

const deleted = z.object({ id: z.string().min(1), deleted: z.literal(true) });
const micros = z.number().int().nonnegative().safe();
const usageTotals = z.object({
	total_micros: micros,
	compute_micros: micros,
	llm_micros: micros,
	brave_micros: micros,
	composio_micros: micros,
	perflo_micros: micros,
	llm_calls: micros,
	input_tokens: micros,
	output_tokens: micros,
	awake_minutes: micros,
});
const usage = z.object({
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
	total_micros: micros,
	by_integration: z.object({
		compute: z.object({ cost_micros: micros, awake_minutes: micros }),
		llm: z.object({
			cost_micros: micros,
			calls: micros,
			input_tokens: micros,
			output_tokens: micros,
		}),
		brave: z.object({ cost_micros: micros }),
		composio: z.object({ cost_micros: micros }),
		perflo: z.object({ cost_micros: micros }),
	}),
	by_model: z.array(
		z.object({
			model: z.string(),
			cost_micros: micros,
			calls: micros,
			input_tokens: micros,
			output_tokens: micros,
		}),
	),
	days: z.array(usageTotals.extend({ date: z.string() })),
	instances: z.array(usageTotals.extend({ id: z.string() })),
});
export type Agent37Usage = z.infer<typeof usage>;
const usageQuery = z.object({
	from: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/u)
		.optional(),
	to: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/u)
		.optional(),
});
export type Agent37UsageQuery = z.infer<typeof usageQuery>;

const errorEnvelope = z.union([
	z.object({ error: z.string() }).transform((value) => ({ code: value.error })),
	z
		.object({
			error: z.object({ code: z.string(), message: z.string().optional() }),
		})
		.transform((value) => value.error),
]);

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

type RequestOptions<T> = {
	readonly method: "GET" | "HEAD" | "POST" | "DELETE";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly expected: readonly number[];
	readonly body?: unknown;
	readonly timeoutMs: number;
	readonly idempotent?: boolean;
} & (
	| {
			readonly responseSchema: z.ZodType<T>;
			readonly responseSchemaForStatus?: undefined;
	  }
	| {
			readonly responseSchema?: undefined;
			readonly responseSchemaForStatus: (status: number) => z.ZodType<T>;
	  }
);

function responseError(
	response: TransportResponse,
	now: number,
	method: RequestOptions<unknown>["method"],
	idempotent: boolean,
): Agent37Error {
	let providerCode: string | undefined;
	try {
		const parsed = errorEnvelope.safeParse(JSON.parse(response.body));
		if (parsed.success) providerCode = parsed.data.code;
	} catch {}
	const retryAfterMs = agent37RetryAfterMs(response, now);
	const errorOptions: Agent37ErrorOptionsDraft = {
		status: response.status,
		retryable:
			(method === "GET" || method === "HEAD" || idempotent) &&
			((response.status >= 500 && response.status <= 599) ||
				providerCode === "no_capacity" ||
				providerCode === "try_again"),
	};
	if (providerCode !== undefined) errorOptions.providerCode = providerCode;
	if (retryAfterMs !== undefined) errorOptions.retryAfterMs = retryAfterMs;
	return new Agent37Error(
		`Agent37 returned ${response.status}${providerCode === undefined ? "" : ` ${providerCode}`}: ${response.body}`,
		errorOptions,
	);
}

export function createAgent37Client(
	options: Agent37ClientOptions,
): Agent37Client {
	const apiKey = z.string().startsWith("sk_live_").parse(options.apiKey);
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
		if (!input.expected.includes(response.status))
			throw responseError(
				response,
				now(),
				input.method,
				input.idempotent ?? false,
			);
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
		const responseSchema =
			input.responseSchema ?? input.responseSchemaForStatus(response.status);
		const parsed = responseSchema.safeParse(json);
		if (!parsed.success)
			throw new Agent37Error(
				`Agent37 response did not match its contract: ${parsed.error.message}`,
				{ status: response.status },
			);
		return parsed.data;
	}

	const apiHeaders = {
		accept: "application/json",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	};
	const execHeaders = {
		accept: "application/json",
		"content-type": "application/json",
		"x-agent37-key": apiKey,
	};
	const apiUrl = (path: string) => `${AGENT37_API_ORIGIN}${path}`;

	return {
		createInstance(input) {
			return request({
				method: "POST",
				url: apiUrl("/v1/instances"),
				headers: apiHeaders,
				expected: [201],
				responseSchema: instance,
				body: createInstanceInput.parse(input),
				timeoutMs: AGENT37_MAX_TIMEOUT_MS,
			});
		},
		getInstance(id) {
			return request({
				method: "GET",
				url: apiUrl(`/v1/instances/${encodeURIComponent(id)}`),
				headers: apiHeaders,
				expected: [200],
				responseSchema: instance,
				timeoutMs,
			});
		},
		listInstances() {
			return request({
				method: "GET",
				url: apiUrl("/v1/instances"),
				headers: apiHeaders,
				expected: [200],
				responseSchema: instanceList,
				timeoutMs,
			});
		},
		async deleteInstance(id) {
			await request({
				method: "DELETE",
				url: apiUrl(`/v1/instances/${encodeURIComponent(id)}`),
				headers: apiHeaders,
				expected: [200, 204],
				responseSchemaForStatus: (status) =>
					status === 204 ? z.undefined() : deleted,
				timeoutMs,
			});
		},
		exec(id, input) {
			const body = execInput.parse(input);
			return request({
				method: "POST",
				url: `${AGENT37_EXEC_ORIGIN}/v1/instances/${encodeURIComponent(id)}/exec`,
				headers: execHeaders,
				expected: [200],
				responseSchema: execResult,
				body,
				timeoutMs: AGENT37_MAX_TIMEOUT_MS,
				idempotent: body.name !== undefined,
			});
		},
		registerWebhook(url) {
			return request({
				method: "POST",
				url: apiUrl("/v1/webhooks"),
				headers: apiHeaders,
				expected: [201],
				responseSchema: registeredWebhook,
				body: {
					url: z
						.url()
						.refine((value) => new URL(value).protocol === "https:", {
							message: "Agent37 webhooks require HTTPS",
						})
						.parse(url),
				},
				timeoutMs,
			});
		},
		listWebhooks() {
			return request({
				method: "GET",
				url: apiUrl("/v1/webhooks"),
				headers: apiHeaders,
				expected: [200],
				responseSchema: webhookList,
				timeoutMs,
			});
		},
		async deleteWebhook(id) {
			await request({
				method: "DELETE",
				url: apiUrl(`/v1/webhooks/${encodeURIComponent(id)}`),
				headers: apiHeaders,
				expected: [200, 204],
				responseSchemaForStatus: (status) =>
					status === 204 ? z.undefined() : deleted,
				timeoutMs,
			});
		},
		usage(query = {}) {
			const parsed = usageQuery.parse(query);
			const search = new URLSearchParams();
			if (parsed.from !== undefined) search.set("from", parsed.from);
			if (parsed.to !== undefined) search.set("to", parsed.to);
			const suffix = search.size === 0 ? "" : `?${search.toString()}`;
			return request({
				method: "GET",
				url: apiUrl(`/v1/usage${suffix}`),
				headers: apiHeaders,
				expected: [200],
				responseSchema: usage,
				timeoutMs,
			});
		},
	};
}
