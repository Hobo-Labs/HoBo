import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const EXEC_STREAM_LIMIT_CHARS = 512 * 1024;
const EXEC_NAME_REUSE_WINDOW_MS = 300_000;
const WEBHOOK_LIMIT = 5;
const WEBHOOK_DELIVERY_TIMEOUT_MS = 2_000;
const NETWORK_ALLOW_LIMIT = 100;
const DEFAULT_WALLET_USD = 5;
const DEFAULT_MEMORY_LIMIT_GB = 32;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 3_600;
const MEMORY_BILLING_STATUSES: ReadonlySet<string> = new Set([
	"provisioning",
	"running",
	"starting",
	"restarting",
	"waking",
	"updating",
	"stopping",
]);
const tagOf = Object.prototype.toString;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonString(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
	return value === true || value === false;
}

export function isJsonArray(
	value: JsonValue | undefined,
): value is JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export const AGENT37_INSTANCE_TYPES = ["default", "vm", "performance"] as const;
export type Agent37InstanceType = (typeof AGENT37_INSTANCE_TYPES)[number];

export const AGENT37_REGIONS = ["us", "eu", "ap-south"] as const;
export type Agent37Region = (typeof AGENT37_REGIONS)[number];

export const AGENT37_INSTANCE_STATUSES = [
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
] as const;
export type Agent37InstanceStatus = (typeof AGENT37_INSTANCE_STATUSES)[number];

export type Agent37InstanceSize = {
	readonly cpu: number;
	readonly memoryGb: number;
	readonly monthlyUsd: number;
	readonly vmOnly: boolean;
};

export const AGENT37_INSTANCE_SIZES: readonly Agent37InstanceSize[] = [
	{ cpu: 2, memoryGb: 4, monthlyUsd: 4.76, vmOnly: false },
	{ cpu: 4, memoryGb: 8, monthlyUsd: 9.34, vmOnly: false },
	{ cpu: 4, memoryGb: 16, monthlyUsd: 15.48, vmOnly: false },
	{ cpu: 4, memoryGb: 32, monthlyUsd: 27.76, vmOnly: false },
	{ cpu: 8, memoryGb: 64, monthlyUsd: 55.52, vmOnly: true },
];

const TYPE_RATE_MULTIPLIER = {
	default: 1,
	vm: 2.5,
	performance: 4,
} satisfies Record<Agent37InstanceType, number>;

export type Agent37NetworkRule =
	| "allow-all"
	| "deny-all"
	| { readonly allow: readonly string[] };

export type FakeAgent37Instance = {
	readonly id: string;
	name: string | null;
	template: string;
	readonly type: Agent37InstanceType;
	readonly region: Agent37Region;
	resources: {
		readonly cpu: number;
		readonly memoryGb: number;
		readonly diskGb: number;
	};
	status: Agent37InstanceStatus;
	readonly metadata: { readonly [key: string]: string };
	readonly env: { readonly [key: string]: string };
	autoSleep: boolean;
	idleTimeoutSeconds: number;
	readonly publicPorts: readonly number[];
	readonly network: Agent37NetworkRule;
	readonly mountPath: string | null;
	readonly created_at: string;
	updated_at: string;
};

export type FakeAgent37ExecInvocation = {
	readonly command: string;
	readonly user: string;
	readonly instanceId: string;
	readonly background: boolean;
	readonly name: string | null;
	readonly env: { readonly [key: string]: string };
};

export type FakeAgent37ExecOutcome = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

export type FakeAgent37ExecHandler = (
	invocation: FakeAgent37ExecInvocation,
) => FakeAgent37ExecOutcome;

export type FakeAgent37Fault = {
	readonly status: number;
	readonly code: string;
	readonly retryAfterSeconds?: number;
};

export type FakeAgent37WebhookRegistration = {
	readonly id: string;
	url: string;
	readonly created_at: string;
	readonly secret: string;
};

export type FakeAgent37WebhookDelivery = {
	readonly webhookId: string;
	readonly eventId: string;
	readonly timestampSeconds: number;
	readonly signature: string;
	readonly body: string;
	readonly instanceId: string;
	readonly previousStatus: Agent37InstanceStatus;
	readonly status: Agent37InstanceStatus;
	readonly responseStatus: number | null;
	readonly error: string | null;
};

export type FakeAgent37InstanceState = {
	apiKey: string;
	walletUsd: number;
	memoryLimitGb: number;
	readonly regionsWithoutCapacity: ReadonlySet<string>;
	failNextRequest: FakeAgent37Fault | null;
	readonly instances: readonly FakeAgent37Instance[];
	readonly execInvocations: readonly FakeAgent37ExecInvocation[];
	readonly webhookDeliveries: readonly FakeAgent37WebhookDelivery[];
};

export type FakeAgent37ServerOptions = {
	readonly apiKey?: string;
	readonly execHandler?: FakeAgent37ExecHandler;
	readonly walletUsd?: number;
	readonly memoryLimitGb?: number;
	readonly now?: () => Date;
	readonly host?: string;
	readonly port?: number;
};

export type FakeAgent37Server = {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly state: FakeAgent37InstanceState;
	close(): Promise<void>;
};

type RouteResult = {
	readonly status: number;
	readonly headers: { readonly [name: string]: string } | null;
	readonly body: JsonValue | null;
};

type RequestAuth = {
	readonly bearer: string | null;
	readonly agent37Key: string | null;
};

type CreateFields = {
	readonly template: string;
	readonly type: Agent37InstanceType;
	readonly region: Agent37Region;
	readonly cpu: number;
	readonly memoryGb: number;
	readonly diskGb: number;
	readonly name: string | null;
	readonly metadata: { readonly [key: string]: string };
	readonly env: { readonly [key: string]: string };
	readonly autoSleep: boolean;
	readonly idleTimeoutSeconds: number;
	readonly publicPorts: readonly number[];
	readonly network: Agent37NetworkRule;
	readonly mountPath: string | null;
	readonly size: Agent37InstanceSize;
};

type ParseFailure = { readonly ok: false; readonly message: string };
type ParseOk<T> = { readonly ok: true; readonly fields: T };
type ParseResult<T> = ParseFailure | ParseOk<T>;

type ExecFields = {
	readonly command: string;
	readonly user: string;
	readonly background: boolean;
	readonly name: string | null;
};

type ExecRecord = {
	readonly resultJson: JsonObject;
	readonly finishedAtMs: number;
};

const LIFECYCLE_VERBS = [
	"stop",
	"start",
	"sleep",
	"restart",
	"update",
] as const;
type LifecycleVerb = (typeof LIFECYCLE_VERBS)[number];

const LIFECYCLE_TABLE = {
	stop: {
		from: ["running", "starting", "restarting", "waking", "updating"],
		to: "stopped",
	},
	start: { from: ["stopped", "sleeping"], to: "running" },
	sleep: { from: ["running"], to: "sleeping" },
	restart: { from: ["running"], to: "running" },
	update: { from: ["running", "stopped"], to: "running" },
} satisfies Record<
	LifecycleVerb,
	{
		readonly from: readonly Agent37InstanceStatus[];
		readonly to: Agent37InstanceStatus;
	}
>;

export function generateAgent37TestApiKey(): string {
	return `sk_live_${randomBytes(24).toString("base64url")}`;
}

function isAddressInfo(
	address: string | AddressInfo | null,
): address is AddressInfo {
	return address !== null && tagOf.call(address) === "[object Object]";
}

function singleHeader(
	headers: IncomingHttpHeaders,
	name: string,
): string | null {
	const value = headers[name];
	if (value === undefined) return null;
	if (Array.isArray(value)) return value[0] ?? null;
	return value;
}

function jsonResult(status: number, body: JsonValue): RouteResult {
	return { status, headers: null, body };
}

function errorResult(
	status: number,
	code: string,
	message: string,
): RouteResult {
	return { status, headers: null, body: { error: { code, message } } };
}

function unauthorizedApi(): RouteResult {
	return errorResult(
		401,
		"unauthorized",
		"missing or invalid Authorization bearer key",
	);
}

function unauthorizedExec(): RouteResult {
	return errorResult(
		401,
		"unauthorized",
		"missing or invalid X-Agent37-Key header",
	);
}

function notFound(): RouteResult {
	return errorResult(404, "not_found", "unknown resource");
}

function methodNotAllowed(): RouteResult {
	return errorResult(405, "method_not_allowed", "unsupported method");
}

function stringField(object: JsonObject, name: string): string | null {
	const value = object[name];
	return isJsonString(value) ? value : null;
}

function instanceTypeOf(
	value: JsonValue | undefined,
): Agent37InstanceType | null {
	if (!isJsonString(value)) return null;
	return (
		AGENT37_INSTANCE_TYPES.find((candidate) => candidate === value) ?? null
	);
}

function regionOf(value: JsonValue | undefined): Agent37Region | null {
	if (!isJsonString(value)) return null;
	return AGENT37_REGIONS.find((candidate) => candidate === value) ?? null;
}

function lifecycleVerbOf(value: string): LifecycleVerb | null {
	return LIFECYCLE_VERBS.find((verb) => verb === value) ?? null;
}

function sizeFor(cpu: number, memoryGb: number): Agent37InstanceSize | null {
	return (
		AGENT37_INSTANCE_SIZES.find(
			(size) => size.cpu === cpu && size.memoryGb === memoryGb,
		) ?? null
	);
}

function stringRecordOf(
	value: JsonValue | undefined,
): { readonly [key: string]: string } | null {
	if (value === undefined) return {};
	if (!isJsonObject(value)) return null;
	const entries: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isJsonString(entry)) return null;
		entries[key] = entry;
	}
	return entries;
}

function networkOf(value: JsonValue | undefined): Agent37NetworkRule | null {
	if (value === undefined) return "allow-all";
	if (isJsonString(value)) {
		if (value === "allow-all" || value === "deny-all") return value;
		return null;
	}
	if (isJsonObject(value)) {
		const allow = value.allow;
		if (!isJsonArray(allow)) return null;
		if (allow.length > NETWORK_ALLOW_LIMIT) return null;
		const entries: string[] = [];
		for (const entry of allow) {
			if (!isJsonString(entry)) return null;
			entries.push(entry);
		}
		return { allow: entries };
	}
	return null;
}

function wholeNumberOf(object: JsonObject, name: string): number | null {
	const value = object[name];
	if (!isJsonNumber(value)) return null;
	if (!Number.isInteger(value)) return null;
	return value;
}

function serializeNetwork(network: Agent37NetworkRule): JsonValue {
	if (isJsonObject(network)) return { allow: [...network.allow] };
	return network;
}

type SerializedAgent37Instance = {
	id: string;
	template: string;
	type: Agent37InstanceType;
	region: Agent37Region;
	resources: { cpu: number; memory: number; disk: number };
	status: Agent37InstanceStatus;
	auto_sleep: boolean;
	idle_timeout_seconds: number;
	public_ports: number[];
	network: JsonValue;
	created_at: string;
	updated_at: string;
	name?: string;
	metadata?: { readonly [key: string]: string };
	mount_path?: string;
};

function serializeInstance(instance: FakeAgent37Instance) {
	const json: SerializedAgent37Instance = {
		id: instance.id,
		template: instance.template,
		type: instance.type,
		region: instance.region,
		resources: {
			cpu: instance.resources.cpu,
			memory: instance.resources.memoryGb,
			disk: instance.resources.diskGb,
		},
		status: instance.status,
		auto_sleep: instance.autoSleep,
		idle_timeout_seconds: instance.idleTimeoutSeconds,
		public_ports: [...instance.publicPorts],
		network: serializeNetwork(instance.network),
		created_at: instance.created_at,
		updated_at: instance.updated_at,
	};
	if (instance.name !== null) json.name = instance.name;
	if (Object.keys(instance.metadata).length > 0)
		json.metadata = { ...instance.metadata };
	if (instance.mountPath !== null) json.mount_path = instance.mountPath;
	return json;
}

function parseCreateRequest(body: JsonValue): ParseResult<CreateFields> {
	if (!isJsonObject(body))
		return { ok: false, message: "request body must be a JSON object" };
	const template = stringField(body, "template");
	if (template === null || template === "")
		return { ok: false, message: "template must be a non-empty string" };
	const type = instanceTypeOf(body.type);
	if (type === null)
		return {
			ok: false,
			message: `type must be one of ${AGENT37_INSTANCE_TYPES.join(", ")}`,
		};
	const region = regionOf(body.region ?? "us");
	if (region === null)
		return {
			ok: false,
			message: `region must be one of ${AGENT37_REGIONS.join(", ")}`,
		};
	const resources = body.resources;
	if (!isJsonObject(resources))
		return {
			ok: false,
			message: "resources must be an object with cpu, memory, and disk",
		};
	const cpu = wholeNumberOf(resources, "cpu");
	if (cpu === null || cpu < 1)
		return {
			ok: false,
			message: "resources.cpu must be a whole number of at least 1",
		};
	const memoryGb = wholeNumberOf(resources, "memory");
	if (memoryGb === null || memoryGb < 1)
		return {
			ok: false,
			message: "resources.memory must be a whole number of GB of at least 1",
		};
	const diskGb = wholeNumberOf(resources, "disk");
	if (diskGb === null || diskGb < 1 || diskGb > 1024)
		return {
			ok: false,
			message: "resources.disk must be a whole number of GB between 1 and 1024",
		};
	const size = sizeFor(cpu, memoryGb);
	if (size === null)
		return {
			ok: false,
			message: `no documented instance size has ${cpu} vCPU and ${memoryGb} GB`,
		};
	if (size.vmOnly && type === "default")
		return {
			ok: false,
			message: `the ${cpu} vCPU / ${memoryGb} GB size runs only on vm and performance instances`,
		};
	const nameValue = body.name;
	if (nameValue !== undefined && !isJsonString(nameValue))
		return { ok: false, message: "name must be a string" };
	const metadata = stringRecordOf(body.metadata);
	if (metadata === null)
		return { ok: false, message: "metadata must map strings to strings" };
	const env = stringRecordOf(body.env);
	if (env === null)
		return { ok: false, message: "env must map strings to strings" };
	const autoSleepValue = body.auto_sleep;
	const autoSleep = autoSleepValue === undefined ? false : autoSleepValue;
	if (!isJsonBoolean(autoSleep))
		return { ok: false, message: "auto_sleep must be a boolean" };
	const idleValue = body.idle_timeout_seconds;
	const idleTimeoutSeconds =
		idleValue === undefined ? DEFAULT_IDLE_TIMEOUT_SECONDS : idleValue;
	if (
		!isJsonNumber(idleTimeoutSeconds) ||
		!Number.isInteger(idleTimeoutSeconds) ||
		idleTimeoutSeconds < 300 ||
		idleTimeoutSeconds > 86_400
	)
		return {
			ok: false,
			message: "idle_timeout_seconds must be a whole number in 300-86400",
		};
	const portsValue = body.public_ports;
	const publicPorts: number[] = [];
	if (portsValue !== undefined) {
		if (!isJsonArray(portsValue))
			return { ok: false, message: "public_ports must be an array of ports" };
		for (const port of portsValue) {
			if (
				!isJsonNumber(port) ||
				!Number.isInteger(port) ||
				port < 1 ||
				port > 65_535
			)
				return {
					ok: false,
					message: "public_ports entries must be whole port numbers 1-65535",
				};
			publicPorts.push(port);
		}
	}
	const network = networkOf(body.network);
	if (network === null)
		return {
			ok: false,
			message: `network must be "allow-all", "deny-all", or an allow list of at most ${NETWORK_ALLOW_LIMIT} entries`,
		};
	const mountValue = body.mount_path;
	if (mountValue !== undefined && !isJsonString(mountValue))
		return { ok: false, message: "mount_path must be a string" };
	return {
		ok: true,
		fields: {
			template,
			type,
			region,
			cpu,
			memoryGb,
			diskGb,
			name: nameValue === undefined ? null : nameValue,
			metadata,
			env,
			autoSleep,
			idleTimeoutSeconds,
			publicPorts,
			network,
			mountPath: mountValue === undefined ? null : mountValue,
			size,
		},
	};
}

function parseExecRequest(body: JsonValue): ParseResult<ExecFields> {
	if (!isJsonObject(body))
		return { ok: false, message: "request body must be a JSON object" };
	const command = stringField(body, "command");
	if (command === null || command === "")
		return { ok: false, message: "command must be a non-empty string" };
	const userValue = body.user;
	const user = userValue === undefined ? "root" : userValue;
	if (!isJsonString(user) || user !== "root")
		return { ok: false, message: 'user must be "root" when present' };
	const backgroundValue = body.background;
	const background = backgroundValue === undefined ? false : backgroundValue;
	if (!isJsonBoolean(background))
		return { ok: false, message: "background must be a boolean" };
	const nameValue = body.name;
	if (nameValue !== undefined && !isJsonString(nameValue))
		return { ok: false, message: "name must be a string" };
	return {
		ok: true,
		fields: {
			command,
			user,
			background,
			name: nameValue === undefined ? null : nameValue,
		},
	};
}

function readRequestBody(request: IncomingMessage): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let overflow = false;
		request.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > REQUEST_BODY_LIMIT_BYTES) {
				overflow = true;
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			resolve(overflow ? null : Buffer.concat(chunks).toString("utf8"));
		});
		request.on("error", () => {
			resolve(null);
		});
	});
}

function decodeWebhookSecret(secret: string): Buffer {
	return Buffer.from(secret.slice("whsec_".length), "base64");
}

export async function createAgent37FakeServer(
	options: FakeAgent37ServerOptions = {},
): Promise<FakeAgent37Server> {
	const apiKey =
		options.apiKey ?? `sk_live_${randomBytes(24).toString("base64url")}`;
	const execHandler =
		options.execHandler ?? (() => ({ stdout: "", stderr: "", exitCode: 0 }));
	const now = options.now ?? (() => new Date());
	const nowMs = () => now().getTime();
	const isoNow = () => now().toISOString();

	const instances: FakeAgent37Instance[] = [];
	const execInvocations: FakeAgent37ExecInvocation[] = [];
	const deliveries: FakeAgent37WebhookDelivery[] = [];
	const webhooks: FakeAgent37WebhookRegistration[] = [];
	const execsByName = new Map<string, ExecRecord>();
	const regionsWithoutCapacity = new Set<string>();

	const state: FakeAgent37InstanceState = {
		apiKey,
		walletUsd: options.walletUsd ?? DEFAULT_WALLET_USD,
		memoryLimitGb: options.memoryLimitGb ?? DEFAULT_MEMORY_LIMIT_GB,
		regionsWithoutCapacity,
		failNextRequest: null,
		instances,
		execInvocations,
		webhookDeliveries: deliveries,
	};

	function memoryInUseGb(): number {
		return instances
			.filter((instance) => MEMORY_BILLING_STATUSES.has(instance.status))
			.reduce((total, instance) => total + instance.resources.memoryGb, 0);
	}

	async function fireStatusEvent(
		previous: Agent37InstanceStatus,
		instance: FakeAgent37Instance,
	): Promise<void> {
		if (webhooks.length === 0) return;
		const body = JSON.stringify({
			type: "instance.status_changed",
			created_at: instance.updated_at,
			data: {
				previous_status: previous,
				instance: serializeInstance(instance),
			},
		});
		for (const webhook of webhooks) {
			const eventId = randomUUID();
			const timestampSeconds = Math.floor(nowMs() / 1000);
			const signature = `v1,${createHmac(
				"sha256",
				decodeWebhookSecret(webhook.secret),
			)
				.update(`${eventId}.${timestampSeconds}.${body}`)
				.digest("base64")}`;
			let responseStatus: number | null = null;
			let failure: string | null = null;
			try {
				const response = await fetch(webhook.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"webhook-id": eventId,
						"webhook-timestamp": String(timestampSeconds),
						"webhook-signature": signature,
					},
					body,
					signal: AbortSignal.timeout(WEBHOOK_DELIVERY_TIMEOUT_MS),
				});
				responseStatus = response.status;
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			deliveries.push({
				webhookId: webhook.id,
				eventId,
				timestampSeconds,
				signature,
				body,
				instanceId: instance.id,
				previousStatus: previous,
				status: instance.status,
				responseStatus,
				error: failure,
			});
		}
	}

	function findInstance(id: string): FakeAgent37Instance | undefined {
		return instances.find((candidate) => candidate.id === id);
	}

	function buildInstance(fields: CreateFields): FakeAgent37Instance {
		const createdAt = isoNow();
		return {
			id: `i_${randomBytes(9).toString("hex")}`,
			name: fields.name,
			template: fields.template,
			type: fields.type,
			region: fields.region,
			resources: {
				cpu: fields.cpu,
				memoryGb: fields.memoryGb,
				diskGb: fields.diskGb,
			},
			status: "running",
			metadata: fields.metadata,
			env: fields.env,
			autoSleep: fields.autoSleep,
			idleTimeoutSeconds: fields.idleTimeoutSeconds,
			publicPorts: fields.publicPorts,
			network: fields.network,
			mountPath: fields.mountPath,
			created_at: createdAt,
			updated_at: createdAt,
		};
	}

	async function createThroughGuards(
		fields: CreateFields,
	): Promise<RouteResult> {
		if (fields.region !== "us" && fields.type === "default")
			return errorResult(
				400,
				"invalid_request",
				`region ${fields.region} runs only vm and performance instances`,
			);
		if (regionsWithoutCapacity.has(fields.region))
			return errorResult(
				503,
				"no_capacity",
				`region ${fields.region} has no capacity`,
			);
		const dayRateUsd =
			(fields.size.monthlyUsd * TYPE_RATE_MULTIPLIER[fields.type]) / 30;
		if (state.walletUsd < dayRateUsd)
			return errorResult(
				402,
				"insufficient_balance",
				`creating this instance needs at least one day of its rate (${dayRateUsd.toFixed(4)} USD) in the wallet`,
			);
		if (memoryInUseGb() + fields.memoryGb > state.memoryLimitGb)
			return errorResult(
				409,
				"instance_limit_reached",
				`workspace memory ceiling is ${state.memoryLimitGb} GB and ${memoryInUseGb()} GB is already running`,
			);
		const instance = buildInstance(fields);
		instances.push(instance);
		await fireStatusEvent("provisioning", instance);
		return jsonResult(201, serializeInstance(instance));
	}

	async function handleLifecycle(
		instance: FakeAgent37Instance,
		verb: LifecycleVerb,
		body: JsonValue,
	): Promise<RouteResult> {
		const transition = LIFECYCLE_TABLE[verb];
		if (!transition.from.includes(instance.status))
			return errorResult(
				409,
				"invalid_state",
				`cannot ${verb} an instance in status ${instance.status}`,
			);
		if (verb === "update") {
			if (!isJsonObject(body))
				return errorResult(400, "invalid_request", "update needs a template");
			const template = stringField(body, "template");
			if (template === null || template === "")
				return errorResult(
					400,
					"invalid_request",
					"template must be a non-empty string",
				);
			instance.template = template;
		}
		const previous = instance.status;
		instance.status = transition.to;
		instance.updated_at = isoNow();
		if (previous !== transition.to) await fireStatusEvent(previous, instance);
		return jsonResult(200, serializeInstance(instance));
	}

	function parseResizeTarget(
		instance: FakeAgent37Instance,
		body: JsonValue,
	):
		| {
				readonly ok: true;
				readonly cpu: number;
				readonly memoryGb: number;
				readonly diskGb: number;
		  }
		| { readonly ok: false; readonly message: string } {
		if (!isJsonObject(body))
			return { ok: false, message: "resize needs resources" };
		const resources = body.resources;
		if (!isJsonObject(resources))
			return {
				ok: false,
				message: "resources must be an object with cpu and memory",
			};
		const cpu = wholeNumberOf(resources, "cpu");
		if (cpu === null || cpu < 1)
			return {
				ok: false,
				message: "resources.cpu must be a whole number of at least 1",
			};
		const memoryGb = wholeNumberOf(resources, "memory");
		if (memoryGb === null || memoryGb < 1)
			return {
				ok: false,
				message: "resources.memory must be a whole number of GB of at least 1",
			};
		const size = sizeFor(cpu, memoryGb);
		if (size === null)
			return {
				ok: false,
				message: `no documented instance size has ${cpu} vCPU and ${memoryGb} GB`,
			};
		if (size.vmOnly && instance.type === "default")
			return {
				ok: false,
				message: `the ${cpu} vCPU / ${memoryGb} GB size runs only on vm and performance instances`,
			};
		const diskGb =
			resources.disk === undefined
				? instance.resources.diskGb
				: wholeNumberOf(resources, "disk");
		if (diskGb === null || diskGb < 1 || diskGb > 1024)
			return {
				ok: false,
				message:
					"resources.disk must be a whole number of GB between 1 and 1024",
			};
		return { ok: true, cpu, memoryGb, diskGb };
	}

	async function handleResize(
		instance: FakeAgent37Instance,
		body: JsonValue,
	): Promise<RouteResult> {
		const target = parseResizeTarget(instance, body);
		if (!target.ok) return errorResult(400, "invalid_request", target.message);
		const memoryDelta = target.memoryGb - instance.resources.memoryGb;
		if (memoryDelta > 0 && memoryInUseGb() + memoryDelta > state.memoryLimitGb)
			return errorResult(
				409,
				"instance_limit_reached",
				`workspace memory ceiling is ${state.memoryLimitGb} GB and ${memoryInUseGb()} GB is already running`,
			);
		instance.resources = {
			cpu: target.cpu,
			memoryGb: target.memoryGb,
			diskGb: target.diskGb,
		};
		instance.updated_at = isoNow();
		return jsonResult(200, serializeInstance(instance));
	}

	async function handleFork(
		parent: FakeAgent37Instance,
		body: JsonValue,
	): Promise<RouteResult> {
		const forkBody = isJsonObject(body) ? body : {};
		const nameValue = forkBody.name;
		if (nameValue !== undefined && !isJsonString(nameValue))
			return errorResult(400, "invalid_request", "name must be a string");
		const metadataValue = forkBody.metadata;
		const metadata = stringRecordOf(metadataValue);
		if (metadata === null)
			return errorResult(
				400,
				"invalid_request",
				"metadata must map strings to strings",
			);
		const size = sizeFor(parent.resources.cpu, parent.resources.memoryGb);
		if (size === null)
			return errorResult(
				400,
				"invalid_request",
				"parent instance does not carry a documented size",
			);
		return createThroughGuards({
			template: parent.template,
			type: parent.type,
			region: parent.region,
			cpu: parent.resources.cpu,
			memoryGb: parent.resources.memoryGb,
			diskGb: parent.resources.diskGb,
			name: nameValue === undefined ? null : nameValue,
			metadata: metadataValue === undefined ? parent.metadata : metadata,
			env: {},
			autoSleep: parent.autoSleep,
			idleTimeoutSeconds: parent.idleTimeoutSeconds,
			publicPorts: parent.publicPorts,
			network: parent.network,
			mountPath: parent.mountPath,
			size,
		});
	}

	async function handleExec(
		instance: FakeAgent37Instance,
		body: JsonValue,
	): Promise<RouteResult> {
		const parsed = parseExecRequest(body);
		if (!parsed.ok) return errorResult(400, "invalid_request", parsed.message);
		if (instance.status !== "running")
			return errorResult(
				409,
				"instance_not_running",
				`instance ${instance.id} is ${instance.status}, not running`,
			);
		const reuseKey =
			parsed.fields.name === null
				? null
				: `${instance.id}:${parsed.fields.name}`;
		if (reuseKey !== null) {
			const earlier = execsByName.get(reuseKey);
			if (
				earlier !== undefined &&
				nowMs() - earlier.finishedAtMs <= EXEC_NAME_REUSE_WINDOW_MS
			)
				return jsonResult(200, earlier.resultJson);
		}
		const invocation: FakeAgent37ExecInvocation = {
			command: parsed.fields.command,
			user: parsed.fields.user,
			instanceId: instance.id,
			background: parsed.fields.background,
			name: parsed.fields.name,
			env: instance.env,
		};
		const outcome = execHandler(invocation);
		execInvocations.push(invocation);
		const execId = `ex_${randomBytes(8).toString("hex")}`;
		const createdAt = isoNow();
		const completed = {
			id: execId,
			instance_id: instance.id,
			background: parsed.fields.background,
			status: "completed",
			exit_code: outcome.exitCode,
			stdout: outcome.stdout.slice(0, EXEC_STREAM_LIMIT_CHARS),
			stderr: outcome.stderr.slice(0, EXEC_STREAM_LIMIT_CHARS),
			created_at: createdAt,
			finished_at: createdAt,
		};
		const result = parsed.fields.background
			? {
					id: execId,
					instance_id: instance.id,
					background: true,
					status: "running",
					exit_code: null,
					stdout: "",
					stderr: "",
					created_at: createdAt,
					finished_at: null,
				}
			: completed;
		if (reuseKey !== null)
			execsByName.set(reuseKey, {
				resultJson: result,
				finishedAtMs: nowMs(),
			});
		return jsonResult(200, result);
	}

	function handleWebhookCreate(body: JsonValue): RouteResult {
		if (!isJsonObject(body))
			return errorResult(400, "invalid_request", "webhook needs a url");
		const url = stringField(body, "url");
		if (url === null || url === "")
			return errorResult(
				400,
				"invalid_request",
				"url must be a non-empty string",
			);
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			return errorResult(400, "invalid_request", "url is not a valid URL");
		}
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
			parsedUrl.hostname,
		);
		if (
			parsedUrl.protocol !== "https:" &&
			(parsedUrl.protocol !== "http:" || !loopback)
		)
			return errorResult(
				400,
				"invalid_request",
				"webhook urls must be https; plain http is accepted only for loopback receivers",
			);
		if (webhooks.length >= WEBHOOK_LIMIT)
			return errorResult(
				409,
				"webhook_limit_reached",
				`a workspace may register at most ${WEBHOOK_LIMIT} webhooks`,
			);
		const webhook: FakeAgent37WebhookRegistration = {
			id: `wh_${randomBytes(8).toString("hex")}`,
			url,
			created_at: isoNow(),
			secret: `whsec_${randomBytes(32).toString("base64")}`,
		};
		webhooks.push(webhook);
		return jsonResult(201, {
			id: webhook.id,
			url: webhook.url,
			secret: webhook.secret,
			created_at: webhook.created_at,
		});
	}

	async function route(
		method: string,
		pathname: string,
		rawBody: string | null,
		auth: RequestAuth,
	): Promise<RouteResult> {
		const parseBody = (): JsonValue | null => {
			if (rawBody === null || rawBody.trim() === "") return null;
			try {
				const value: JsonValue = JSON.parse(rawBody);
				return value;
			} catch {
				return null;
			}
		};
		const underInstances =
			pathname === "/v1/instances" || pathname.startsWith("/v1/instances/");
		const underWebhooks =
			pathname === "/v1/webhooks" || pathname.startsWith("/v1/webhooks/");
		if (!underInstances && !underWebhooks && pathname !== "/v1/usage")
			return notFound();
		const execPlane = underInstances && pathname.endsWith("/exec");
		const authorized = execPlane
			? auth.agent37Key === apiKey
			: auth.bearer === `Bearer ${apiKey}`;
		if (!authorized) return execPlane ? unauthorizedExec() : unauthorizedApi();
		if (state.failNextRequest !== null) {
			const fault = state.failNextRequest;
			state.failNextRequest = null;
			return {
				status: fault.status,
				headers:
					fault.retryAfterSeconds === undefined
						? null
						: { "retry-after": String(fault.retryAfterSeconds) },
				body: { error: { code: fault.code, message: "injected fault" } },
			};
		}
		if (pathname === "/v1/usage") {
			if (method !== "GET") return methodNotAllowed();
			const totals = {
				total_micros: 0,
				compute_micros: 0,
				llm_micros: 0,
				brave_micros: 0,
				composio_micros: 0,
				perflo_micros: 0,
				llm_calls: 0,
				input_tokens: 0,
				output_tokens: 0,
				awake_minutes: 0,
			};
			return jsonResult(200, {
				from: "2026-11-01",
				to: "2026-11-20",
				total_micros: 0,
				by_integration: {
					compute: { cost_micros: 0, awake_minutes: 0 },
					llm: {
						cost_micros: 0,
						calls: 0,
						input_tokens: 0,
						output_tokens: 0,
					},
					brave: { cost_micros: 0 },
					composio: { cost_micros: 0 },
					perflo: { cost_micros: 0 },
				},
				by_model: [],
				days: [{ date: "2026-11-01", ...totals }],
				instances: [],
			});
		}
		if (pathname === "/v1/instances") {
			if (method === "POST") {
				const parsedBody = parseBody();
				if (parsedBody === null)
					return errorResult(
						400,
						"invalid_request",
						"request body must be JSON",
					);
				const parsed = parseCreateRequest(parsedBody);
				if (!parsed.ok)
					return errorResult(400, "invalid_request", parsed.message);
				return createThroughGuards(parsed.fields);
			}
			if (method === "GET")
				return jsonResult(200, {
					instances: [...instances]
						.reverse()
						.map((instance) => serializeInstance(instance)),
				});
			return methodNotAllowed();
		}
		if (pathname === "/v1/webhooks") {
			if (method === "POST") {
				const parsedBody = parseBody();
				if (parsedBody === null)
					return errorResult(
						400,
						"invalid_request",
						"request body must be JSON",
					);
				return handleWebhookCreate(parsedBody);
			}
			if (method === "GET")
				return jsonResult(200, {
					webhooks: webhooks.map((webhook) => ({
						id: webhook.id,
						url: webhook.url,
						created_at: webhook.created_at,
					})),
				});
			return methodNotAllowed();
		}
		if (pathname.startsWith("/v1/webhooks/")) {
			const id = pathname.slice("/v1/webhooks/".length);
			const index = webhooks.findIndex((webhook) => webhook.id === id);
			if (method === "DELETE") {
				if (index < 0) return notFound();
				webhooks.splice(index, 1);
				return { status: 204, headers: null, body: null };
			}
			return methodNotAllowed();
		}
		const suffix = pathname.slice("/v1/instances/".length);
		const segments = suffix.split("/");
		const instanceId = segments[0] ?? "";
		if (segments.length === 1) {
			const instance = findInstance(instanceId);
			if (method === "GET") {
				if (instance === undefined) return notFound();
				return jsonResult(200, serializeInstance(instance));
			}
			if (method === "DELETE") {
				if (instance === undefined) return notFound();
				const previous = instance.status;
				instance.status = "deleting";
				instance.updated_at = isoNow();
				await fireStatusEvent(previous, instance);
				const index = instances.indexOf(instance);
				if (index >= 0) instances.splice(index, 1);
				return { status: 204, headers: null, body: null };
			}
			return methodNotAllowed();
		}
		if (segments.length === 2 && method === "POST") {
			const verb = segments[1] ?? "";
			const instance = findInstance(instanceId);
			if (instance === undefined) return notFound();
			if (verb === "exec") {
				const parsedBody = parseBody();
				if (parsedBody === null)
					return errorResult(
						400,
						"invalid_request",
						"request body must be JSON",
					);
				return handleExec(instance, parsedBody);
			}
			if (verb === "resize") {
				const parsedBody = parseBody();
				if (parsedBody === null)
					return errorResult(
						400,
						"invalid_request",
						"request body must be JSON",
					);
				return handleResize(instance, parsedBody);
			}
			if (verb === "fork") {
				const parsedBody = parseBody();
				if (parsedBody === null)
					return errorResult(
						400,
						"invalid_request",
						"request body must be JSON",
					);
				return handleFork(instance, parsedBody);
			}
			const lifecycleVerb = lifecycleVerbOf(verb);
			if (lifecycleVerb === null) return notFound();
			const parsedBody = parseBody();
			if (parsedBody === null)
				return errorResult(400, "invalid_request", "request body must be JSON");
			return handleLifecycle(instance, lifecycleVerb, parsedBody);
		}
		return notFound();
	}

	const server = createServer(
		(request: IncomingMessage, response: ServerResponse) => {
			void dispatch(request, response);
		},
	);

	async function dispatch(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		let result: RouteResult;
		try {
			const url = new URL(request.url ?? "/", "http://api.agent37.invalid");
			const rawBody =
				request.method === "GET" || request.method === "HEAD"
					? ""
					: await readRequestBody(request);
			result =
				rawBody === null
					? errorResult(
							413,
							"request_too_large",
							`request bodies are capped at ${REQUEST_BODY_LIMIT_BYTES} bytes`,
						)
					: await route(request.method ?? "GET", url.pathname, rawBody, {
							bearer: singleHeader(request.headers, "authorization"),
							agent37Key: singleHeader(request.headers, "x-agent37-key"),
						});
		} catch {
			result = errorResult(500, "internal_error", "internal server error");
		}
		if (result.body === null) {
			if (result.headers === null) {
				response.writeHead(result.status);
			} else {
				response.writeHead(result.status, result.headers);
			}
			response.end();
			return;
		}
		const headers = {
			"content-type": "application/json",
			...Object.fromEntries(Object.entries(result.headers ?? {})),
		};
		response.writeHead(result.status, headers);
		response.end(JSON.stringify(result.body));
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			{ host: options.host ?? "127.0.0.1", port: options.port ?? 0 },
			() => resolve(),
		);
	});
	const address = server.address();
	const port = isAddressInfo(address) ? address.port : (options.port ?? 0);
	const baseUrl = `http://${options.host ?? "127.0.0.1"}:${port}`;

	async function close(): Promise<void> {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error === undefined) {
					resolve();
					return;
				}
				reject(error);
			});
		});
	}

	return { baseUrl, apiKey, state, close };
}
