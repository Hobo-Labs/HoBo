import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const MAX_BODY_BYTES = 1_048_576;
const MAX_EXEC_STREAM_BYTES = 512 * 1024;
const EXEC_REPLAY_MS = 300_000;
const MAX_WEBHOOKS = 5;
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

const typeRate = {
	default: 1,
	vm: 2.5,
	performance: 4,
} satisfies Record<Agent37InstanceType, number>;

const billedMemoryStatuses: ReadonlySet<Agent37InstanceStatus> = new Set([
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
	readonly regionsWithoutCapacity: Set<string>;
	failNextRequest: FakeAgent37Fault | null;
	readonly instances: FakeAgent37Instance[];
	readonly execInvocations: FakeAgent37ExecInvocation[];
	readonly webhookDeliveries: FakeAgent37WebhookDelivery[];
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

export type ParsedCreate = {
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

export type ParsedExec = {
	readonly command: string;
	readonly user: "root";
	readonly background: boolean;
	readonly name: string | null;
};

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

type ExecReplay = {
	readonly response: JsonObject;
	readonly finishedAt: number;
};

const transitions = {
	stop: {
		from: ["running", "starting", "restarting", "waking", "updating"],
		to: "stopped",
	},
	start: { from: ["stopped", "sleeping"], to: "running" },
	sleep: { from: ["running"], to: "sleeping" },
	restart: { from: ["running"], to: "running" },
	update: { from: ["running", "stopped"], to: "running" },
} as const;

type LifecycleVerb = keyof typeof transitions;

function isLifecycleVerb(value: string | undefined): value is LifecycleVerb {
	return value !== undefined && Object.hasOwn(transitions, value);
}

function ok(status: number, body: JsonValue): RouteResult {
	return { status, body };
}

function error(status: number, code: string, message: string): RouteResult {
	return { status, body: { error: { code, message } } };
}

function invalid(message: string): RouteResult {
	return error(400, "invalid_request", message);
}

function notFound(): RouteResult {
	return error(404, "not_found", "unknown resource");
}

function methodNotAllowed(): RouteResult {
	return error(405, "method_not_allowed", "unsupported method");
}

function requestHeader(
	headers: IncomingHttpHeaders,
	name: string,
): string | null {
	const value = headers[name];
	return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function textField(object: JsonObject, name: string): string | null {
	const value = object[name];
	return isJsonString(value) ? value : null;
}

function integerField(object: JsonObject, name: string): number | null {
	const value = object[name];
	return isJsonNumber(value) && Number.isInteger(value) ? value : null;
}

function stringMap(
	value: JsonValue | undefined,
): { readonly [key: string]: string } | null {
	if (value === undefined) return {};
	if (!isJsonObject(value)) return null;
	const result: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isJsonString(entry)) return null;
		result[key] = entry;
	}
	return result;
}

function parseInstanceType(
	value: JsonValue | undefined,
): Agent37InstanceType | null {
	if (!isJsonString(value)) return null;
	return AGENT37_INSTANCE_TYPES.find((entry) => entry === value) ?? null;
}

function parseRegion(value: JsonValue | undefined): Agent37Region | null {
	if (!isJsonString(value)) return null;
	return AGENT37_REGIONS.find((entry) => entry === value) ?? null;
}

function findSize(cpu: number, memoryGb: number): Agent37InstanceSize | null {
	return (
		AGENT37_INSTANCE_SIZES.find(
			(entry) => entry.cpu === cpu && entry.memoryGb === memoryGb,
		) ?? null
	);
}

function parseNetwork(value: JsonValue | undefined): Agent37NetworkRule | null {
	if (value === undefined || value === "allow-all" || value === "deny-all") {
		return value ?? "allow-all";
	}
	if (!isJsonObject(value) || !isJsonArray(value.allow)) return null;
	if (value.allow.length > 100) return null;
	const allow: string[] = [];
	for (const entry of value.allow) {
		if (!isJsonString(entry)) return null;
		allow.push(entry);
	}
	return { allow };
}

function networkJson(rule: Agent37NetworkRule): JsonValue {
	return rule === "allow-all" || rule === "deny-all"
		? rule
		: { allow: [...rule.allow] };
}

function instanceJson(instance: FakeAgent37Instance) {
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
		network: networkJson(instance.network),
		mount_path: instance.mountPath,
		created_at: instance.created_at,
		updated_at: instance.updated_at,
	};
}

export function parseCreate(body: JsonValue | undefined): ParseResult<ParsedCreate> {
	if (!isJsonObject(body)) {
		return { ok: false, message: "request body must be a JSON object" };
	}
	const template = textField(body, "template");
	if (template === null || template === "") {
		return { ok: false, message: "template must be a non-empty string" };
	}
	const type = parseInstanceType(body.type);
	if (type === null) return { ok: false, message: "type is invalid" };
	const region = parseRegion(body.region ?? "us");
	if (region === null) return { ok: false, message: "region is invalid" };
	if (!isJsonObject(body.resources)) {
		return { ok: false, message: "resources must be an object" };
	}
	const cpu = integerField(body.resources, "cpu");
	const memoryGb = integerField(body.resources, "memory");
	const diskGb = integerField(body.resources, "disk");
	if (cpu === null || cpu < 1) {
		return { ok: false, message: "resources.cpu is invalid" };
	}
	if (memoryGb === null || memoryGb < 1) {
		return { ok: false, message: "resources.memory is invalid" };
	}
	if (diskGb === null || diskGb < 1 || diskGb > 1024) {
		return {
			ok: false,
			message: "resources.disk must be between 1 and 1024",
		};
	}
	const size = findSize(cpu, memoryGb);
	if (size === null) {
		return { ok: false, message: "instance size is not documented" };
	}
	if (size.virtualMachineOnly && type === "default") {
		return {
			ok: false,
			message: "the selected size requires vm or performance",
		};
	}
	const rawName = body.name;
	if (rawName !== undefined && !isJsonString(rawName)) {
		return { ok: false, message: "name must be a string" };
	}
	const metadata = stringMap(body.metadata);
	if (metadata === null) {
		return { ok: false, message: "metadata must map strings to strings" };
	}
	const env = stringMap(body.env);
	if (env === null) {
		return { ok: false, message: "env must map strings to strings" };
	}
	const autoSleep = body.auto_sleep ?? false;
	if (!isJsonBoolean(autoSleep)) {
		return { ok: false, message: "auto_sleep must be a boolean" };
	}
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
	if (body.public_ports !== undefined) {
		if (!isJsonArray(body.public_ports)) {
			return { ok: false, message: "public_ports must be an array" };
		}
		for (const entry of body.public_ports) {
			const port = isJsonObject(entry) ? integerField(entry, "port") : entry;
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
	const network = parseNetwork(body.network);
	if (network === null) return { ok: false, message: "network is invalid" };
	const rawMountPath = body.mount_path;
	if (rawMountPath !== undefined && !isJsonString(rawMountPath)) {
		return { ok: false, message: "mount_path must be a string" };
	}
	return {
		ok: true,
		value: {
			template,
			type,
			region,
			cpu,
			memoryGb,
			diskGb,
			name: rawName === undefined ? null : rawName,
			metadata,
			env,
			autoSleep,
			idleTimeoutSeconds,
			publicPorts,
			network,
			mountPath: rawMountPath === undefined ? null : rawMountPath,
			size,
		},
	};
}

export function parseExec(body: JsonValue | undefined): ParseResult<ParsedExec> {
	if (!isJsonObject(body)) {
		return { ok: false, message: "request body must be a JSON object" };
	}
	const command = textField(body, "command");
	if (command === null || command === "") {
		return { ok: false, message: "command must be a non-empty string" };
	}
	const user = body.user ?? "root";
	if (user !== "root") return { ok: false, message: 'user must be "root"' };
	const background = body.background ?? false;
	if (!isJsonBoolean(background)) {
		return { ok: false, message: "background must be a boolean" };
	}
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

async function readRequestBody(
	request: IncomingMessage,
): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let oversized = false;
		request.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
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

function boundedExecStream(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	return bytes.length <= MAX_EXEC_STREAM_BYTES
		? value
		: bytes.subarray(0, MAX_EXEC_STREAM_BYTES).toString("utf8");
}

function permitsLoopbackHttp(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
	);
}

function isTcpAddress(
	address: string | AddressInfo | null,
): address is AddressInfo {
	return address !== null && objectTag.call(address) === "[object Object]";
}

function tcpPort(address: string | AddressInfo | null): number | null {
	return isTcpAddress(address) ? address.port : null;
}

export function generateAgent37TestApiKey(): string {
	return `sk_live_${randomBytes(24).toString("base64url")}`;
}

export async function createAgent37FakeServer(
	options: FakeAgent37ServerOptions = {},
): Promise<FakeAgent37Server> {
	const apiKey = options.apiKey ?? generateAgent37TestApiKey();
	const execute =
		options.execHandler ?? (() => ({ stdout: "", stderr: "", exitCode: 0 }));
	const now = options.now ?? (() => new Date());
	const webhookFetch = options.webhookFetch ?? globalThis.fetch;
	const webhookTimeoutMs = options.webhookTimeoutMs ?? 2000;
	const instances: FakeAgent37Instance[] = [];
	const execInvocations: FakeAgent37ExecInvocation[] = [];
	const webhookDeliveries: FakeAgent37WebhookDelivery[] = [];
	const webhooks: FakeAgent37WebhookRegistration[] = [];
	const replay = new Map<string, ExecReplay>();
	const state: FakeAgent37InstanceState = {
		apiKey,
		walletUsd: options.walletUsd ?? 5,
		memoryLimitGb: options.memoryLimitGb ?? 32,
		regionsWithoutCapacity: new Set<string>(),
		failNextRequest: null,
		instances,
		execInvocations,
		webhookDeliveries,
	};

	function memoryInUse(): number {
		return instances
			.filter((instance) => billedMemoryStatuses.has(instance.status))
			.reduce((sum, instance) => sum + instance.resources.memoryGb, 0);
	}

	async function publishStatus(
		previousStatus: Agent37InstanceStatus,
		instance: FakeAgent37Instance,
	): Promise<void> {
		const body = JSON.stringify({
			type: "instance.status_changed",
			created_at: instance.updated_at,
			data: {
				previous_status: previousStatus,
				instance: instanceJson(instance),
			},
		});
		for (const webhook of webhooks) {
			const eventId = randomUUID();
			const timestampSeconds = Math.floor(now().getTime() / 1000);
			const key = Buffer.from(webhook.secret.slice(6), "base64");
			const signature = `v1,${createHmac("sha256", key)
				.update(`${eventId}.${timestampSeconds}.${body}`)
				.digest("base64")}`;
			let responseStatus: number | null = null;
			let deliveryError: string | null = null;
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
				deliveryError = cause instanceof Error ? cause.message : String(cause);
			}
			webhookDeliveries.push({
				webhookId: webhook.id,
				eventId,
				timestampSeconds,
				signature,
				body,
				instanceId: instance.id,
				previousStatus,
				status: instance.status,
				responseStatus,
				error: deliveryError,
			});
		}
	}

	async function createInstance(input: ParsedCreate): Promise<RouteResult> {
		if (input.type === "default" && input.region !== "us") {
			return invalid("default instances run only in us");
		}
		if (state.regionsWithoutCapacity.has(input.region)) {
			return error(
				503,
				"no_capacity",
				`region ${input.region} has no capacity`,
			);
		}
		const requiredWallet = (input.size.monthlyUsd * typeRate[input.type]) / 30;
		if (state.walletUsd < requiredWallet) {
			return error(
				402,
				"insufficient_balance",
				"wallet cannot cover one day of the instance rate",
			);
		}
		if (memoryInUse() + input.memoryGb > state.memoryLimitGb) {
			return error(
				409,
				"instance_limit_reached",
				"workspace memory ceiling would be exceeded",
			);
		}
		const timestamp = now().toISOString();
		const instance: FakeAgent37Instance = {
			id: `i_${randomBytes(9).toString("hex")}`,
			name: input.name,
			template: input.template,
			type: input.type,
			region: input.region,
			resources: {
				cpu: input.cpu,
				memoryGb: input.memoryGb,
				diskGb: input.diskGb,
			},
			status: "running",
			metadata: input.metadata,
			env: input.env,
			autoSleep: input.autoSleep,
			idleTimeoutSeconds: input.idleTimeoutSeconds,
			publicPorts: input.publicPorts,
			network: input.network,
			mountPath: input.mountPath,
			created_at: timestamp,
			updated_at: timestamp,
		};
		instances.push(instance);
		await publishStatus("provisioning", instance);
		return ok(201, instanceJson(instance));
	}

	function instanceById(id: string): FakeAgent37Instance | undefined {
		return instances.find((instance) => instance.id === id);
	}

	async function lifecycle(
		instance: FakeAgent37Instance,
		verb: LifecycleVerb,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		const transition = transitions[verb];
		const allowed: readonly Agent37InstanceStatus[] = transition.from;
		if (!allowed.includes(instance.status)) {
			return error(
				409,
				"invalid_state",
				`cannot ${verb} while ${instance.status}`,
			);
		}
		if (verb === "update") {
			if (!isJsonObject(body)) return invalid("update needs a template");
			const template = textField(body, "template");
			if (template === null || template === "") {
				return invalid("template must be non-empty");
			}
			instance.template = template;
		}
		const previousStatus = instance.status;
		instance.status = transition.to;
		instance.updated_at = now().toISOString();
		if (previousStatus !== instance.status) {
			await publishStatus(previousStatus, instance);
		}
		return ok(200, instanceJson(instance));
	}

	async function resize(
		instance: FakeAgent37Instance,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		if (!isJsonObject(body) || !isJsonObject(body.resources)) {
			return invalid("resize needs resources");
		}
		const cpu = integerField(body.resources, "cpu");
		const memoryGb = integerField(body.resources, "memory");
		const size =
			cpu === null || memoryGb === null ? null : findSize(cpu, memoryGb);
		if (cpu === null || memoryGb === null || size === null) {
			return invalid("resize target is not a documented size");
		}
		if (size.virtualMachineOnly && instance.type === "default") {
			return invalid("the selected size requires vm or performance");
		}
		const diskGb =
			body.resources.disk === undefined
				? instance.resources.diskGb
				: integerField(body.resources, "disk");
		if (diskGb === null || diskGb < 1 || diskGb > 1024) {
			return invalid("resources.disk must be between 1 and 1024");
		}
		const additionalMemory = Math.max(
			0,
			memoryGb - instance.resources.memoryGb,
		);
		if (memoryInUse() + additionalMemory > state.memoryLimitGb) {
			return error(
				409,
				"instance_limit_reached",
				"workspace memory ceiling would be exceeded",
			);
		}
		instance.resources = { cpu, memoryGb, diskGb };
		instance.updated_at = now().toISOString();
		return ok(200, instanceJson(instance));
	}

	async function fork(
		parent: FakeAgent37Instance,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		const input = body ?? {};
		if (!isJsonObject(input)) return invalid("fork body must be an object");
		const rawName = input.name;
		if (rawName !== undefined && !isJsonString(rawName)) {
			return invalid("name must be a string");
		}
		const metadata = stringMap(input.metadata);
		if (metadata === null) {
			return invalid("metadata must map strings to strings");
		}
		const size = findSize(parent.resources.cpu, parent.resources.memoryGb);
		if (size === null) return invalid("parent size is not documented");
		return createInstance({
			template: parent.template,
			type: parent.type,
			region: parent.region,
			cpu: parent.resources.cpu,
			memoryGb: parent.resources.memoryGb,
			diskGb: parent.resources.diskGb,
			name: rawName === undefined ? null : rawName,
			metadata: input.metadata === undefined ? parent.metadata : metadata,
			env: {},
			autoSleep: parent.autoSleep,
			idleTimeoutSeconds: parent.idleTimeoutSeconds,
			publicPorts: parent.publicPorts,
			network: parent.network,
			mountPath: parent.mountPath,
			size,
		});
	}

	async function exec(
		instance: FakeAgent37Instance,
		body: JsonValue | undefined,
	): Promise<RouteResult> {
		const parsed = parseExec(body);
		if (!parsed.ok) return invalid(parsed.message);
		if (instance.status !== "running") {
			return error(
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
			now().getTime() - previous.finishedAt <= EXEC_REPLAY_MS
		) {
			return ok(200, previous.response);
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
		execInvocations.push(invocation);
		const timestamp = now().toISOString();
		const response = {
			id: `ex_${randomBytes(8).toString("hex")}`,
			instance_id: instance.id,
			background: parsed.value.background,
			status: parsed.value.background ? "running" : "completed",
			exit_code: parsed.value.background ? null : outcome.exitCode,
			stdout: parsed.value.background ? "" : boundedExecStream(outcome.stdout),
			stderr: parsed.value.background ? "" : boundedExecStream(outcome.stderr),
			created_at: timestamp,
			finished_at: parsed.value.background ? null : timestamp,
		};
		if (replayKey !== null) {
			replay.set(replayKey, { response, finishedAt: now().getTime() });
		}
		return ok(200, response);
	}

	function registerWebhook(body: JsonValue | undefined): RouteResult {
		if (!isJsonObject(body)) return invalid("webhook needs a url");
		const rawUrl = textField(body, "url");
		if (rawUrl === null || rawUrl === "")
			return invalid("url must be non-empty");
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return invalid("url is invalid");
		}
		if (url.protocol !== "https:" && !permitsLoopbackHttp(url)) {
			return invalid("webhook urls require HTTPS or loopback HTTP");
		}
		if (webhooks.length >= MAX_WEBHOOKS) {
			return error(
				409,
				"webhook_limit_reached",
				"workspace webhook limit reached",
			);
		}
		const webhook: FakeAgent37WebhookRegistration = {
			id: `wh_${randomBytes(8).toString("hex")}`,
			url: rawUrl,
			created_at: now().toISOString(),
			secret: `whsec_${randomBytes(32).toString("base64")}`,
		};
		webhooks.push(webhook);
		return ok(201, {
			id: webhook.id,
			url: webhook.url,
			created_at: webhook.created_at,
			secret: webhook.secret,
		});
	}

	function usage(url: URL): RouteResult {
		const today = now().toISOString().slice(0, 10);
		const from = url.searchParams.get("from") ?? today;
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
		return ok(200, {
			from,
			to: url.searchParams.get("to") ?? today,
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
			days: [{ date: from, ...totals }],
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
		const execPath = instancePath && path.endsWith("/exec");
		const authorized = execPath
			? execKey === apiKey
			: authorization === `Bearer ${apiKey}`;
		if (!authorized) {
			return error(
				401,
				"unauthorized",
				execPath
					? "missing or invalid X-Agent37-Key header"
					: "missing or invalid Authorization bearer key",
			);
		}
		if (state.failNextRequest !== null) {
			const fault = state.failNextRequest;
			state.failNextRequest = null;
			const body = {
				error: { code: fault.code, message: "injected fault" },
			};
			if (fault.retryAfterSeconds === undefined) {
				return { status: fault.status, body };
			}
			return {
				status: fault.status,
				headers: { "retry-after": String(fault.retryAfterSeconds) },
				body,
			};
		}
		const body = parseJson(rawBody);
		if (rawBody.trim() !== "" && body === undefined) {
			return invalid("request body must be JSON");
		}
		if (path === "/v1/usage")
			return method === "GET" ? usage(url) : methodNotAllowed();
		if (path === "/v1/instances") {
			if (method === "GET") {
				return ok(200, {
					instances: [...instances].reverse().map(instanceJson),
				});
			}
			if (method === "POST") {
				const parsed = parseCreate(body);
				return parsed.ok
					? createInstance(parsed.value)
					: invalid(parsed.message);
			}
			return methodNotAllowed();
		}
		if (path === "/v1/webhooks") {
			if (method === "GET") {
				return ok(200, {
					webhooks: webhooks.map((webhook) => ({
						id: webhook.id,
						url: webhook.url,
						created_at: webhook.created_at,
					})),
				});
			}
			return method === "POST" ? registerWebhook(body) : methodNotAllowed();
		}
		if (webhookPath) {
			if (method !== "DELETE") return methodNotAllowed();
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
		const instance = instanceById(segments[0] ?? "");
		if (instance === undefined) return notFound();
		if (segments.length === 1) {
			if (method === "GET") return ok(200, instanceJson(instance));
			if (method === "DELETE") {
				const previousStatus = instance.status;
				instance.status = "deleting";
				instance.updated_at = now().toISOString();
				await publishStatus(previousStatus, instance);
				instances.splice(instances.indexOf(instance), 1);
				return { status: 204 };
			}
			return methodNotAllowed();
		}
		if (segments.length !== 2 || method !== "POST") return notFound();
		const verb = segments[1];
		if (verb === "exec") return exec(instance, body);
		if (verb === "resize") return resize(instance, body);
		if (verb === "fork") return fork(instance, body);
		if (isLifecycleVerb(verb)) return lifecycle(instance, verb, body);
		return notFound();
	}

	async function dispatch(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		let result: RouteResult;
		try {
			const url = new URL(request.url ?? "/", "http://fake.agent37.invalid");
			const rawBody = ["GET", "HEAD"].includes(request.method ?? "GET")
				? ""
				: await readRequestBody(request);
			result =
				rawBody === null
					? error(
							413,
							"request_too_large",
							"request body exceeds 1048576 bytes",
						)
					: await route(
							request.method ?? "GET",
							url,
							rawBody,
							requestHeader(request.headers, "authorization"),
							requestHeader(request.headers, "x-agent37-key"),
						);
		} catch {
			result = error(500, "internal_error", "internal server error");
		}
		const headers = Object.entries(result.headers ?? {});
		if (result.body !== undefined)
			headers.push(["content-type", "application/json"]);
		response.writeHead(result.status, Object.fromEntries(headers));
		response.end(
			result.body === undefined ? undefined : JSON.stringify(result.body),
		);
	}

	const server = createServer((request, response) => {
		void dispatch(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			{ host: options.host ?? "127.0.0.1", port: options.port ?? 0 },
			resolve,
		);
	});
	const host = options.host ?? "127.0.0.1";
	const port = tcpPort(server.address()) ?? options.port ?? 0;
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
				server.close((closeError) =>
					closeError === undefined ? resolve() : reject(closeError),
				);
			});
		},
	};
}
