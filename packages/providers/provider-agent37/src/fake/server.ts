import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const BODY_LIMIT = 1_048_576;
const EXEC_OUTPUT_LIMIT = 512 * 1024;
const EXEC_REPLAY_WINDOW = 300_000;
const WEBHOOK_LIMIT = 5;
const objectTag = Object.prototype.toString;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonString(value: JsonValue | undefined): value is string {
	return objectTag.call(value) === "[object String]";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return objectTag.call(value) === "[object Number]";
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
		objectTag.call(value) === "[object Object]"
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
	readonly virtualMachineOnly: boolean;
};

export const AGENT37_INSTANCE_SIZES: readonly Agent37InstanceSize[] = [
	{ cpu: 2, memoryGb: 4, monthlyUsd: 4.76, virtualMachineOnly: false },
	{ cpu: 4, memoryGb: 8, monthlyUsd: 9.34, virtualMachineOnly: false },
	{ cpu: 4, memoryGb: 16, monthlyUsd: 15.48, virtualMachineOnly: false },
	{ cpu: 4, memoryGb: 32, monthlyUsd: 27.76, virtualMachineOnly: false },
	{ cpu: 8, memoryGb: 64, monthlyUsd: 55.52, virtualMachineOnly: true },
];

const rateMultipliers = {
	default: 1,
	vm: 2.5,
	performance: 4,
} satisfies Record<Agent37InstanceType, number>;

const memoryStatuses: ReadonlySet<Agent37InstanceStatus> = new Set([
	"provisioning",
	"running",
	"starting",
	"restarting",
	"waking",
	"updating",
	"stopping",
]);

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
	readonly webhookFetch?: typeof globalThis.fetch;
	readonly webhookTimeoutMs?: number;
};

export type FakeAgent37Server = {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly state: FakeAgent37InstanceState;
	close(): Promise<void>;
};

type RouteResult = {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: JsonValue;
};

type ParsedCreate = {
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

type ParsedExec = {
	readonly command: string;
	readonly user: string;
	readonly background: boolean;
	readonly name: string | null;
};

type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

type ReplayRecord = {
	readonly body: JsonObject;
	readonly finishedAt: number;
};

const lifecycle = {
	stop: {
		from: ["running", "starting", "restarting", "waking", "updating"],
		to: "stopped",
	},
	start: { from: ["stopped", "sleeping"], to: "running" },
	sleep: { from: ["running"], to: "sleeping" },
	restart: { from: ["running"], to: "running" },
	update: { from: ["running", "stopped"], to: "running" },
} as const;
type LifecycleVerb = keyof typeof lifecycle;

function isLifecycleVerb(value: string | undefined): value is LifecycleVerb {
	return value !== undefined && Object.hasOwn(lifecycle, value);
}

export function generateAgent37TestApiKey(): string {
	return `sk_live_${randomBytes(24).toString("base64url")}`;
}

function success(status: number, body: JsonValue): RouteResult {
	return { status, body };
}

function failure(status: number, code: string, message: string): RouteResult {
	return { status, body: { error: { code, message } } };
}

function invalidRequest(message: string): RouteResult {
	return failure(400, "invalid_request", message);
}

function notFound(): RouteResult {
	return failure(404, "not_found", "unknown resource");
}

function wrongMethod(): RouteResult {
	return failure(405, "method_not_allowed", "unsupported method");
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
	const value = headers[name];
	if (Array.isArray(value)) return value[0] ?? null;
	return value ?? null;
}

function isAddressInfo(
	address: string | AddressInfo | null,
): address is AddressInfo {
	return address !== null && objectTag.call(address) === "[object Object]";
}

function addressPort(address: string | AddressInfo | null): number | null {
	return isAddressInfo(address) ? address.port : null;
}

function stringField(object: JsonObject, name: string): string | null {
	const value = object[name];
	return isJsonString(value) ? value : null;
}

function integerField(object: JsonObject, name: string): number | null {
	const value = object[name];
	return isJsonNumber(value) && Number.isInteger(value) ? value : null;
}

function stringRecord(value: JsonValue | undefined): {
	readonly [key: string]: string;
} | null {
	if (value === undefined) return {};
	if (!isJsonObject(value)) return null;
	const result: { [key: string]: string } = {};
	for (const [key, item] of Object.entries(value)) {
		if (!isJsonString(item)) return null;
		result[key] = item;
	}
	return result;
}

function instanceType(
	value: JsonValue | undefined,
): Agent37InstanceType | null {
	if (!isJsonString(value)) return null;
	return AGENT37_INSTANCE_TYPES.find((item) => item === value) ?? null;
}

function region(value: JsonValue | undefined): Agent37Region | null {
	if (!isJsonString(value)) return null;
	return AGENT37_REGIONS.find((item) => item === value) ?? null;
}

function size(cpu: number, memoryGb: number): Agent37InstanceSize | null {
	return (
		AGENT37_INSTANCE_SIZES.find(
			(item) => item.cpu === cpu && item.memoryGb === memoryGb,
		) ?? null
	);
}

function network(value: JsonValue | undefined): Agent37NetworkRule | null {
	if (value === undefined) return "allow-all";
	if (value === "allow-all" || value === "deny-all") return value;
	if (!isJsonObject(value)) return null;
	const allow = value.allow;
	if (!isJsonArray(allow) || allow.length > 100) return null;
	const entries: string[] = [];
	for (const item of allow) {
		if (!isJsonString(item)) return null;
		entries.push(item);
	}
	return { allow: entries };
}

function serializedNetwork(value: Agent37NetworkRule): JsonValue {
	return value === "allow-all" || value === "deny-all"
		? value
		: { allow: [...value.allow] };
}

function serializedInstance(instance: FakeAgent37Instance) {
	return {
		id: instance.id,
		name: instance.name,
		template: instance.template,
		type: instance.type,
		region: instance.region,
		resources: {
			cpu: instance.resources.cpu,
			memory: instance.resources.memoryGb,
			disk: instance.resources.diskGb,
		},
		status: instance.status,
		metadata: { ...instance.metadata },
		auto_sleep: instance.autoSleep,
		idle_timeout_seconds: instance.idleTimeoutSeconds,
		public_ports: [...instance.publicPorts],
		network: serializedNetwork(instance.network),
		mount_path: instance.mountPath,
		created_at: instance.created_at,
		updated_at: instance.updated_at,
	};
}

function parseCreate(body: JsonValue | undefined): ParseResult<ParsedCreate> {
	if (!isJsonObject(body)) {
		return { ok: false, message: "request body must be a JSON object" };
	}
	const template = stringField(body, "template");
	if (template === null || template === "") {
		return { ok: false, message: "template must be a non-empty string" };
	}
	const type = instanceType(body.type);
	if (type === null) return { ok: false, message: "type is invalid" };
	const selectedRegion = region(body.region ?? "us");
	if (selectedRegion === null)
		return { ok: false, message: "region is invalid" };
	const resources = body.resources;
	if (!isJsonObject(resources)) {
		return { ok: false, message: "resources must be an object" };
	}
	const cpu = integerField(resources, "cpu");
	const memoryGb = integerField(resources, "memory");
	const diskGb = integerField(resources, "disk");
	if (cpu === null || cpu < 1)
		return { ok: false, message: "resources.cpu is invalid" };
	if (memoryGb === null || memoryGb < 1) {
		return { ok: false, message: "resources.memory is invalid" };
	}
	if (diskGb === null || diskGb < 1 || diskGb > 1024) {
		return { ok: false, message: "resources.disk must be between 1 and 1024" };
	}
	const selectedSize = size(cpu, memoryGb);
	if (selectedSize === null) {
		return { ok: false, message: "instance size is not documented" };
	}
	if (selectedSize.virtualMachineOnly && type === "default") {
		return {
			ok: false,
			message: "the selected size requires vm or performance",
		};
	}
	const rawName = body.name;
	if (rawName !== undefined && !isJsonString(rawName)) {
		return { ok: false, message: "name must be a string" };
	}
	const metadata = stringRecord(body.metadata);
	if (metadata === null)
		return { ok: false, message: "metadata must map strings to strings" };
	const env = stringRecord(body.env);
	if (env === null)
		return { ok: false, message: "env must map strings to strings" };
	const autoSleep = body.auto_sleep ?? false;
	if (!isJsonBoolean(autoSleep))
		return { ok: false, message: "auto_sleep must be a boolean" };
	const idleTimeoutSeconds = body.idle_timeout_seconds ?? 3600;
	if (
		!isJsonNumber(idleTimeoutSeconds) ||
		!Number.isInteger(idleTimeoutSeconds) ||
		idleTimeoutSeconds < 300 ||
		idleTimeoutSeconds > 86_400
	) {
		return {
			ok: false,
			message: "idle_timeout_seconds must be between 300 and 86400",
		};
	}
	const publicPorts: number[] = [];
	const rawPorts = body.public_ports;
	if (rawPorts !== undefined) {
		if (!isJsonArray(rawPorts))
			return { ok: false, message: "public_ports must be an array" };
		for (const item of rawPorts) {
			const port = isJsonObject(item) ? integerField(item, "port") : item;
			if (
				!isJsonNumber(port) ||
				!Number.isInteger(port) ||
				port < 1 ||
				port > 65_535
			) {
				return { ok: false, message: "public_ports contains an invalid port" };
			}
			publicPorts.push(port);
		}
	}
	const selectedNetwork = network(body.network);
	if (selectedNetwork === null)
		return { ok: false, message: "network is invalid" };
	const mountPath = body.mount_path;
	if (mountPath !== undefined && !isJsonString(mountPath)) {
		return { ok: false, message: "mount_path must be a string" };
	}
	return {
		ok: true,
		value: {
			template,
			type,
			region: selectedRegion,
			cpu,
			memoryGb,
			diskGb,
			name: rawName === undefined ? null : rawName,
			metadata,
			env,
			autoSleep,
			idleTimeoutSeconds,
			publicPorts,
			network: selectedNetwork,
			mountPath: mountPath === undefined ? null : mountPath,
			size: selectedSize,
		},
	};
}

function parseExec(body: JsonValue | undefined): ParseResult<ParsedExec> {
	if (!isJsonObject(body))
		return { ok: false, message: "request body must be a JSON object" };
	const command = stringField(body, "command");
	if (command === null || command === "") {
		return { ok: false, message: "command must be a non-empty string" };
	}
	const user = body.user ?? "root";
	if (user !== "root") return { ok: false, message: 'user must be "root"' };
	const background = body.background ?? false;
	if (!isJsonBoolean(background))
		return { ok: false, message: "background must be a boolean" };
	const rawName = body.name;
	if (rawName !== undefined && (!isJsonString(rawName) || rawName === "")) {
		return { ok: false, message: "name must be a non-empty string" };
	}
	return {
		ok: true,
		value: {
			command,
			user,
			background,
			name: rawName === undefined ? null : rawName,
		},
	};
}

function parseJson(raw: string): JsonValue | undefined {
	if (raw.trim() === "") return undefined;
	try {
		const value: JsonValue = JSON.parse(raw);
		return value;
	} catch {
		return undefined;
	}
}

async function readBody(request: IncomingMessage): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let length = 0;
		let oversized = false;
		request.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length > BODY_LIMIT) {
				oversized = true;
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			resolve(oversized ? null : Buffer.concat(chunks).toString("utf8"));
		});
		request.on("error", () => resolve(null));
	});
}

function limitedOutput(value: string): string {
	const encoded = Buffer.from(value, "utf8");
	return encoded.length <= EXEC_OUTPUT_LIMIT
		? value
		: encoded.subarray(0, EXEC_OUTPUT_LIMIT).toString("utf8");
}

function loopbackHttp(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
	);
}

export async function createAgent37FakeServer(
	options: FakeAgent37ServerOptions = {},
): Promise<FakeAgent37Server> {
	const apiKey = options.apiKey ?? generateAgent37TestApiKey();
	const execute =
		options.execHandler ?? (() => ({ stdout: "", stderr: "", exitCode: 0 }));
	const clock = options.now ?? (() => new Date());
	const webhookFetch = options.webhookFetch ?? globalThis.fetch;
	const webhookTimeoutMs = options.webhookTimeoutMs ?? 2000;
	const instances: FakeAgent37Instance[] = [];
	const invocations: FakeAgent37ExecInvocation[] = [];
	const deliveries: FakeAgent37WebhookDelivery[] = [];
	const webhooks: FakeAgent37WebhookRegistration[] = [];
	const replay = new Map<string, ReplayRecord>();
	const noCapacity = new Set<string>();
	const state: FakeAgent37InstanceState = {
		apiKey,
		walletUsd: options.walletUsd ?? 5,
		memoryLimitGb: options.memoryLimitGb ?? 32,
		regionsWithoutCapacity: noCapacity,
		failNextRequest: null,
		instances,
		execInvocations: invocations,
		webhookDeliveries: deliveries,
	};

	function memoryInUse(): number {
		return instances
			.filter((instance) => memoryStatuses.has(instance.status))
			.reduce((total, instance) => total + instance.resources.memoryGb, 0);
	}

	async function publishStatus(
		previous: Agent37InstanceStatus,
		instance: FakeAgent37Instance,
	): Promise<void> {
		const body = JSON.stringify({
			type: "instance.status_changed",
			created_at: instance.updated_at,
			data: {
				previous_status: previous,
				instance: serializedInstance(instance),
			},
		});
		for (const webhook of webhooks) {
			const eventId = randomUUID();
			const timestampSeconds = Math.floor(clock().getTime() / 1000);
			const key = Buffer.from(webhook.secret.slice(6), "base64");
			const signature = `v1,${createHmac("sha256", key)
				.update(`${eventId}.${timestampSeconds}.${body}`)
				.digest("base64")}`;
			let responseStatus: number | null = null;
			let error: string | null = null;
			try {
				const response = await webhookFetch(webhook.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"webhook-id": eventId,
						"webhook-timestamp": String(timestampSeconds),
						"webhook-signature": signature,
					},
					body,
					signal: AbortSignal.timeout(webhookTimeoutMs),
				});
				responseStatus = response.status;
				await response.body?.cancel();
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
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
				error,
			});
		}
	}

	async function createInstance(fields: ParsedCreate): Promise<RouteResult> {
		if (fields.region !== "us" && fields.type === "default") {
			return invalidRequest("default instances run only in us");
		}
		if (noCapacity.has(fields.region)) {
			return failure(
				503,
				"no_capacity",
				`region ${fields.region} has no capacity`,
			);
		}
		const requiredWallet =
			(fields.size.monthlyUsd * rateMultipliers[fields.type]) / 30;
		if (state.walletUsd < requiredWallet) {
			return failure(
				402,
				"insufficient_balance",
				"wallet cannot cover one day of the instance rate",
			);
		}
		if (memoryInUse() + fields.memoryGb > state.memoryLimitGb) {
			return failure(
				409,
				"instance_limit_reached",
				"workspace memory ceiling would be exceeded",
			);
		}
		const timestamp = clock().toISOString();
		const instance: FakeAgent37Instance = {
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
			created_at: timestamp,
			updated_at: timestamp,
		};
		instances.push(instance);
		await publishStatus("provisioning", instance);
		return success(201, serializedInstance(instance));
	}

	function findInstance(id: string): FakeAgent37Instance | undefined {
		return instances.find((instance) => instance.id === id);
	}

	async function changeLifecycle(
		instance: FakeAgent37Instance,
		verb: LifecycleVerb,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		const transition = lifecycle[verb];
		const allowed: readonly Agent37InstanceStatus[] = transition.from;
		if (!allowed.includes(instance.status)) {
			return failure(
				409,
				"invalid_state",
				`cannot ${verb} while ${instance.status}`,
			);
		}
		if (verb === "update") {
			if (!isJsonObject(body)) return invalidRequest("update needs a template");
			const template = stringField(body, "template");
			if (template === null || template === "")
				return invalidRequest("template must be non-empty");
			instance.template = template;
		}
		const previous = instance.status;
		instance.status = transition.to;
		instance.updated_at = clock().toISOString();
		if (previous !== instance.status) await publishStatus(previous, instance);
		return success(200, serializedInstance(instance));
	}

	async function resize(
		instance: FakeAgent37Instance,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		if (!isJsonObject(body) || !isJsonObject(body.resources)) {
			return invalidRequest("resize needs resources");
		}
		const cpu = integerField(body.resources, "cpu");
		const memoryGb = integerField(body.resources, "memory");
		if (cpu === null || memoryGb === null || size(cpu, memoryGb) === null) {
			return invalidRequest("resize target is not a documented size");
		}
		const selectedSize = size(cpu, memoryGb);
		if (
			selectedSize?.virtualMachineOnly === true &&
			instance.type === "default"
		) {
			return invalidRequest("the selected size requires vm or performance");
		}
		const diskGb =
			body.resources.disk === undefined
				? instance.resources.diskGb
				: integerField(body.resources, "disk");
		if (diskGb === null || diskGb < 1 || diskGb > 1024) {
			return invalidRequest("resources.disk must be between 1 and 1024");
		}
		const increase = Math.max(0, memoryGb - instance.resources.memoryGb);
		if (memoryInUse() + increase > state.memoryLimitGb) {
			return failure(
				409,
				"instance_limit_reached",
				"workspace memory ceiling would be exceeded",
			);
		}
		instance.resources = { cpu, memoryGb, diskGb };
		instance.updated_at = clock().toISOString();
		return success(200, serializedInstance(instance));
	}

	async function fork(
		parent: FakeAgent37Instance,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		const fields = body === undefined ? {} : body;
		if (!isJsonObject(fields))
			return invalidRequest("fork body must be an object");
		const rawName = fields.name;
		if (rawName !== undefined && !isJsonString(rawName))
			return invalidRequest("name must be a string");
		const metadata = stringRecord(fields.metadata);
		if (metadata === null)
			return invalidRequest("metadata must map strings to strings");
		const parentSize = size(parent.resources.cpu, parent.resources.memoryGb);
		if (parentSize === null)
			return invalidRequest("parent size is not documented");
		return createInstance({
			template: parent.template,
			type: parent.type,
			region: parent.region,
			cpu: parent.resources.cpu,
			memoryGb: parent.resources.memoryGb,
			diskGb: parent.resources.diskGb,
			name: rawName === undefined ? null : rawName,
			metadata: fields.metadata === undefined ? parent.metadata : metadata,
			env: {},
			autoSleep: parent.autoSleep,
			idleTimeoutSeconds: parent.idleTimeoutSeconds,
			publicPorts: parent.publicPorts,
			network: parent.network,
			mountPath: parent.mountPath,
			size: parentSize,
		});
	}

	async function exec(
		instance: FakeAgent37Instance,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		const parsed = parseExec(body);
		if (!parsed.ok) return invalidRequest(parsed.message);
		if (instance.status !== "running") {
			return failure(
				409,
				"instance_not_running",
				`instance is ${instance.status}`,
			);
		}
		const replayKey =
			parsed.value.name === null ? null : `${instance.id}:${parsed.value.name}`;
		const previous = replayKey === null ? undefined : replay.get(replayKey);
		if (
			previous !== undefined &&
			clock().getTime() - previous.finishedAt <= EXEC_REPLAY_WINDOW
		) {
			return success(200, previous.body);
		}
		const invocation: FakeAgent37ExecInvocation = {
			command: parsed.value.command,
			user: parsed.value.user,
			instanceId: instance.id,
			background: parsed.value.background,
			name: parsed.value.name,
			env: instance.env,
		};
		const outcome = execute(invocation);
		invocations.push(invocation);
		const timestamp = clock().toISOString();
		const result = {
			id: `ex_${randomBytes(8).toString("hex")}`,
			instance_id: instance.id,
			background: parsed.value.background,
			status: parsed.value.background ? "running" : "completed",
			exit_code: parsed.value.background ? null : outcome.exitCode,
			stdout: parsed.value.background ? "" : limitedOutput(outcome.stdout),
			stderr: parsed.value.background ? "" : limitedOutput(outcome.stderr),
			created_at: timestamp,
			finished_at: parsed.value.background ? null : timestamp,
		};
		if (replayKey !== null)
			replay.set(replayKey, { body: result, finishedAt: clock().getTime() });
		return success(200, result);
	}

	function registerWebhook(body: JsonValue | undefined): RouteResult {
		if (!isJsonObject(body)) return invalidRequest("webhook needs a url");
		const rawUrl = stringField(body, "url");
		if (rawUrl === null || rawUrl === "")
			return invalidRequest("url must be non-empty");
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return invalidRequest("url is invalid");
		}
		if (url.protocol !== "https:" && !loopbackHttp(url)) {
			return invalidRequest("webhook urls require HTTPS or loopback HTTP");
		}
		if (webhooks.length >= WEBHOOK_LIMIT) {
			return failure(
				409,
				"webhook_limit_reached",
				"workspace webhook limit reached",
			);
		}
		const webhook: FakeAgent37WebhookRegistration = {
			id: `wh_${randomBytes(8).toString("hex")}`,
			url: rawUrl,
			created_at: clock().toISOString(),
			secret: `whsec_${randomBytes(32).toString("base64")}`,
		};
		webhooks.push(webhook);
		return success(201, {
			id: webhook.id,
			url: webhook.url,
			created_at: webhook.created_at,
			secret: webhook.secret,
		});
	}

	function usage(url: URL): RouteResult {
		const today = clock().toISOString().slice(0, 10);
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
		return success(200, {
			from: url.searchParams.get("from") ?? today,
			to: url.searchParams.get("to") ?? today,
			total_micros: 0,
			by_integration: {
				compute: { cost_micros: 0, awake_minutes: 0 },
				llm: { cost_micros: 0, calls: 0, input_tokens: 0, output_tokens: 0 },
				brave: { cost_micros: 0 },
				composio: { cost_micros: 0 },
				perflo: { cost_micros: 0 },
			},
			by_model: [],
			days: [{ date: url.searchParams.get("from") ?? today, ...totals }],
			instances: instances.map((instance) => ({ id: instance.id, ...totals })),
		});
	}

	async function route(
		method: string,
		url: URL,
		rawBody: string,
		authorization: string | null,
		execKey: string | null,
	): Promise<RouteResult> {
		const path = url.pathname;
		const instancePath =
			path === "/v1/instances" || path.startsWith("/v1/instances/");
		const webhookPath =
			path === "/v1/webhooks" || path.startsWith("/v1/webhooks/");
		if (!instancePath && !webhookPath && path !== "/v1/usage")
			return notFound();
		const execPlane = instancePath && path.endsWith("/exec");
		const authorized = execPlane
			? execKey === apiKey
			: authorization === `Bearer ${apiKey}`;
		if (!authorized) {
			return failure(
				401,
				"unauthorized",
				execPlane
					? "missing or invalid X-Agent37-Key header"
					: "missing or invalid Authorization bearer key",
			);
		}
		if (state.failNextRequest !== null) {
			const injected = state.failNextRequest;
			state.failNextRequest = null;
			if (injected.retryAfterSeconds === undefined) {
				return {
					status: injected.status,
					body: { error: { code: injected.code, message: "injected fault" } },
				};
			}
			return {
				status: injected.status,
				headers: { "retry-after": String(injected.retryAfterSeconds) },
				body: { error: { code: injected.code, message: "injected fault" } },
			};
		}
		const malformed = rawBody.trim() !== "" && parseJson(rawBody) === undefined;
		if (malformed) return invalidRequest("request body must be JSON");
		const body = parseJson(rawBody);
		if (path === "/v1/usage")
			return method === "GET" ? usage(url) : wrongMethod();
		if (path === "/v1/instances") {
			if (method === "GET") {
				return success(200, {
					instances: [...instances].reverse().map(serializedInstance),
				});
			}
			if (method === "POST") {
				const parsed = parseCreate(body);
				return parsed.ok
					? createInstance(parsed.value)
					: invalidRequest(parsed.message);
			}
			return wrongMethod();
		}
		if (path === "/v1/webhooks") {
			if (method === "GET") {
				return success(200, {
					webhooks: webhooks.map((webhook) => ({
						id: webhook.id,
						url: webhook.url,
						created_at: webhook.created_at,
					})),
				});
			}
			return method === "POST" ? registerWebhook(body) : wrongMethod();
		}
		if (webhookPath) {
			if (method !== "DELETE") return wrongMethod();
			const id = decodeURIComponent(path.slice("/v1/webhooks/".length));
			const index = webhooks.findIndex((webhook) => webhook.id === id);
			if (index < 0) return notFound();
			webhooks.splice(index, 1);
			return { status: 204 };
		}
		const segments = path
			.slice("/v1/instances/".length)
			.split("/")
			.map(decodeURIComponent);
		const instance = findInstance(segments[0] ?? "");
		if (instance === undefined) return notFound();
		if (segments.length === 1) {
			if (method === "GET") return success(200, serializedInstance(instance));
			if (method === "DELETE") {
				const previous = instance.status;
				instance.status = "deleting";
				instance.updated_at = clock().toISOString();
				await publishStatus(previous, instance);
				instances.splice(instances.indexOf(instance), 1);
				return { status: 204 };
			}
			return wrongMethod();
		}
		if (segments.length !== 2 || method !== "POST") return notFound();
		const verb = segments[1];
		if (verb === "exec") return exec(instance, body);
		if (verb === "resize") return resize(instance, body);
		if (verb === "fork") return fork(instance, body);
		if (isLifecycleVerb(verb)) {
			return changeLifecycle(instance, verb, body);
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
			const url = new URL(request.url ?? "/", "http://fake.agent37.invalid");
			const rawBody = ["GET", "HEAD"].includes(request.method ?? "GET")
				? ""
				: await readBody(request);
			result =
				rawBody === null
					? failure(
							413,
							"request_too_large",
							"request body exceeds 1048576 bytes",
						)
					: await route(
							request.method ?? "GET",
							url,
							rawBody,
							header(request.headers, "authorization"),
							header(request.headers, "x-agent37-key"),
						);
		} catch {
			result = failure(500, "internal_error", "internal server error");
		}
		const responseHeaders = Object.entries(result.headers ?? {});
		if (result.body !== undefined) {
			responseHeaders.push(["content-type", "application/json"]);
		}
		response.writeHead(result.status, Object.fromEntries(responseHeaders));
		response.end(
			result.body === undefined ? undefined : JSON.stringify(result.body),
		);
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			{ host: options.host ?? "127.0.0.1", port: options.port ?? 0 },
			resolve,
		);
	});
	const port = addressPort(server.address()) ?? options.port ?? 0;
	const host = options.host ?? "127.0.0.1";
	let closed = false;
	return {
		baseUrl: `http://${host}:${port}`,
		apiKey,
		state,
		async close() {
			if (closed) return;
			closed = true;
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				);
			});
		},
	};
}
