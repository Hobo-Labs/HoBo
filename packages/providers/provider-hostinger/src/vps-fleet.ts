import type {
	HttpTransport,
	TransportMethod,
	TransportResponse,
} from "@hobo/core";

import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
import { redactHostingerText } from "./resolvers.js";
import {
	guardedHostingerTransport,
	HOSTINGER_MAX_RESPONSE_BYTES,
	HOSTINGER_MAX_TIMEOUT_MS,
	HostingerTransportConfigError,
	hostingerApiUrl,
} from "./transport.js";

const VIRTUAL_MACHINES = "/api/vps/v1/virtual-machines";

export const HOSTINGER_VM_POWER_ACTIONS = Object.freeze([
	"restart",
	"start",
] as const);

export type HostingerVmPowerAction =
	(typeof HOSTINGER_VM_POWER_ACTIONS)[number];

export function parseHostingerVmPowerAction(
	value: string,
): HostingerVmPowerAction | undefined {
	return HOSTINGER_VM_POWER_ACTIONS.find((action) => action === value);
}

export interface HostingerFleetMachine {
	readonly id: string;
	readonly hostname: string;
	readonly state: string;
	readonly plan?: string;
	readonly ipv4?: string;
	readonly actionsLock?: string;
}

export interface HostingerFleetActionReceipt {
	readonly machine: HostingerFleetMachine;
	readonly action: HostingerVmPowerAction;
	readonly actionId: string;
	readonly actionState: string;
}

export const HOSTINGER_FLEET_ERROR_CODES = Object.freeze([
	"HOSTINGER_FLEET_ROUTE_REFUSED",
	"HOSTINGER_FLEET_REJECTED",
	"HOSTINGER_FLEET_UNPARSEABLE",
	"HOSTINGER_FLEET_NO_SUCH_MACHINE",
	"HOSTINGER_FLEET_AMBIGUOUS_MACHINE",
	"HOSTINGER_FLEET_LOCKED",
] as const);

export type HostingerFleetErrorCode =
	(typeof HOSTINGER_FLEET_ERROR_CODES)[number];

export class HostingerFleetError extends Error {
	constructor(
		readonly code: HostingerFleetErrorCode,
		message: string,
	) {
		super(message);
		this.name = "HostingerFleetError";
	}
}

const MACHINE_ID = /^[1-9][0-9]{0,18}$/u;
const POWER_ROUTE = new RegExp(
	`^${VIRTUAL_MACHINES}/[1-9][0-9]{0,18}/(?:${HOSTINGER_VM_POWER_ACTIONS.join("|")})$`,
	"u",
);

function fleetRouteAllowed(method: TransportMethod, path: string): boolean {
	if (method === "GET") return path === VIRTUAL_MACHINES;
	return method === "POST" && POWER_ROUTE.test(path);
}

export function guardedHostingerFleetTransport(
	inner: HttpTransport,
): HttpTransport {
	const guarded = guardedHostingerTransport(inner);
	return async (request) => {
		let path: string;
		try {
			path = new URL(request.url).pathname;
		} catch {
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_ROUTE_REFUSED",
				"hostinger fleet: the request URL is not a URL",
			);
		}
		if (!fleetRouteAllowed(request.method, path))
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_ROUTE_REFUSED",
				`hostinger fleet: ${request.method} ${path} is not a fleet route. The fleet lists machines and restarts or starts one it already owns; purchase, setup, recreate and billing routes are refused before any request leaves this process`,
			);
		return guarded(request);
	};
}

function stringField(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return isJsonString(value) && value.trim() !== "" ? value : undefined;
}

function idField(record: JsonObject): string | undefined {
	const value = record.id;
	if (isJsonNumber(value) && Number.isSafeInteger(value) && value > 0)
		return String(value);
	return isJsonString(value) && MACHINE_ID.test(value) ? value : undefined;
}

function firstIpv4(record: JsonObject): string | undefined {
	const addresses = record.ipv4;
	if (!isJsonArray(addresses)) return undefined;
	const first = addresses.find(isJsonObject);
	return first === undefined ? undefined : stringField(first, "address");
}

function parseMachine(value: JsonValue): HostingerFleetMachine {
	const record = isJsonObject(value) ? value : undefined;
	const id = record === undefined ? undefined : idField(record);
	if (record === undefined || id === undefined)
		throw new HostingerFleetError(
			"HOSTINGER_FLEET_UNPARSEABLE",
			"hostinger fleet: a virtual machine record has no usable id",
		);
	const plan = stringField(record, "plan");
	const ipv4 = firstIpv4(record);
	const actionsLock = stringField(record, "actions_lock");
	return {
		id,
		hostname: stringField(record, "hostname") ?? "",
		state: stringField(record, "state") ?? "unknown",
		...(plan !== undefined ? { plan } : undefined),
		...(ipv4 !== undefined ? { ipv4 } : undefined),
		...(actionsLock !== undefined ? { actionsLock } : undefined),
	};
}

export interface HostingerVpsFleetOptions {
	readonly transport: HttpTransport;
	readonly resolveToken: () => Promise<string>;
}

export interface HostingerVpsFleet {
	list(): Promise<readonly HostingerFleetMachine[]>;
	power(
		target: string,
		action: HostingerVmPowerAction,
	): Promise<HostingerFleetActionReceipt>;
}

export function hostingerVpsFleet(
	options: HostingerVpsFleetOptions,
): HostingerVpsFleet {
	const transport = guardedHostingerFleetTransport(options.transport);

	async function call(
		method: TransportMethod,
		path: string,
		label: string,
	): Promise<JsonValue> {
		const token = await options.resolveToken();
		const scrub = (text: string) =>
			redactHostingerText(
				token === "" ? text : text.split(token).join("[redacted]"),
			);
		let response: TransportResponse;
		try {
			response = await transport({
				method,
				url: hostingerApiUrl(path),
				headers: {
					accept: "application/json",
					authorization: `Bearer ${token}`,
				},
				timeoutMs: HOSTINGER_MAX_TIMEOUT_MS,
				maxResponseBytes: HOSTINGER_MAX_RESPONSE_BYTES,
			});
		} catch (error) {
			if (error instanceof HostingerFleetError) throw error;
			if (error instanceof HostingerTransportConfigError)
				throw new HostingerFleetError(
					"HOSTINGER_FLEET_ROUTE_REFUSED",
					scrub(error.message),
				);
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_REJECTED",
				`${label}: ${error instanceof Error ? scrub(error.message) : "the transport failed"}`,
			);
		}
		const parsed = parseJsonValue(response.body);
		if (response.status >= 400) {
			const detail =
				isJsonObject(parsed) && stringField(parsed, "message") !== undefined
					? scrub(stringField(parsed, "message") ?? "")
					: "no error detail was returned";
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_REJECTED",
				`${label}: Hostinger refused the call with status ${response.status}: ${detail}`,
			);
		}
		return parsed;
	}

	async function list(): Promise<readonly HostingerFleetMachine[]> {
		const body = await call(
			"GET",
			VIRTUAL_MACHINES,
			"hostinger list virtual machines",
		);
		const items = isJsonArray(body)
			? body
			: isJsonObject(body) && isJsonArray(body.data)
				? body.data
				: undefined;
		if (items === undefined)
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_UNPARSEABLE",
				"hostinger list virtual machines: the answer is neither a list nor a {data: [...]} envelope",
			);
		return items.map(parseMachine);
	}

	async function power(
		target: string,
		action: HostingerVmPowerAction,
	): Promise<HostingerFleetActionReceipt> {
		const machines = await list();
		const matches = MACHINE_ID.test(target)
			? machines.filter((machine) => machine.id === target)
			: machines.filter((machine) => machine.hostname === target);
		if (matches.length > 1)
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_AMBIGUOUS_MACHINE",
				`hostinger fleet: more than one machine has hostname ${JSON.stringify(target)}; name it by id`,
			);
		const machine = matches[0];
		if (machine === undefined)
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_NO_SUCH_MACHINE",
				`hostinger fleet: no machine in this account is ${JSON.stringify(target)}. The fleet acts only on machines the account already owns and never buys one`,
			);
		if (machine.actionsLock === "locked")
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_LOCKED",
				`hostinger fleet: machine ${machine.id} has an action in progress; wait for it to finish, then ask again`,
			);
		const body = await call(
			"POST",
			`${VIRTUAL_MACHINES}/${encodeURIComponent(machine.id)}/${action}`,
			`hostinger ${action} virtual machine ${machine.id}`,
		);
		const record = isJsonObject(body)
			? isJsonObject(body.data)
				? body.data
				: body
			: undefined;
		const actionId = record === undefined ? undefined : idField(record);
		if (record === undefined || actionId === undefined)
			throw new HostingerFleetError(
				"HOSTINGER_FLEET_UNPARSEABLE",
				`hostinger ${action} virtual machine ${machine.id}: the answer carries no action id, so whether the ${action} was accepted is unknown`,
			);
		return {
			machine,
			action,
			actionId,
			actionState: stringField(record, "state") ?? "unknown",
		};
	}

	return { list, power };
}
