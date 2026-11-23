import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	guardedHostingerFleetTransport,
	HostingerFleetError,
	hostingerVpsFleet,
	parseHostingerVmPowerAction,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const TOKEN = "fakehostingerfleettoken0123456789abcdef";

const pact = parseJsonObject(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"../contracts/provider-hostinger-boundary.pact.json",
		),
		"utf8",
	),
);

type Call = Readonly<{
	method: string;
	path: string;
	authorization: string | undefined;
}>;

interface FakeHostinger {
	readonly transport: HttpTransport;
	readonly calls: Call[];
}

function reply(status: number, payload: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	};
}

const MACHINES: JsonValue = [
	{
		id: 1201,
		hostname: "hobo-arc-1.example.test",
		state: "stopped",
		plan: "KVM 2",
		actions_lock: "unlocked",
		ipv4: [{ id: 1, address: "203.0.113.20" }],
		subscription_id: "sub-not-printed",
	},
	{
		id: 1202,
		hostname: "hobo-arc-2.example.test",
		state: "running",
		plan: "KVM 4",
		actions_lock: "locked",
	},
];

function fake(
	handler: (request: TransportRequest) => TransportResponse = (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/api/vps/v1/virtual-machines")
			return reply(200, MACHINES);
		const power =
			/^\/api\/vps\/v1\/virtual-machines\/(\d+)\/(restart|start)$/u.exec(path);
		if (request.method === "POST" && power !== null)
			return reply(200, {
				id: 9001,
				name: power[2] ?? "",
				state: "sent",
			});
		return reply(500, { message: "unexpected" });
	},
): FakeHostinger {
	const calls: Call[] = [];
	return {
		calls,
		transport: async (request) => {
			calls.push({
				method: request.method,
				path: new URL(request.url).pathname,
				authorization: request.headers.authorization,
			});
			return handler(request);
		},
	};
}

async function failure<Result>(
	run: () => Promise<Result>,
): Promise<HostingerFleetError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof HostingerFleetError) return error;
		throw error;
	}
	throw new Error("expected a HostingerFleetError");
}

describe("hostinger VPS fleet", () => {
	it("lists the account's machines without subscription or token fields", async () => {
		const wire = fake();
		const fleet = hostingerVpsFleet({
			transport: wire.transport,
			resolveToken: async () => TOKEN,
		});
		const machines = await fleet.list();
		expect(machines).toEqual([
			{
				id: "1201",
				hostname: "hobo-arc-1.example.test",
				state: "stopped",
				plan: "KVM 2",
				ipv4: "203.0.113.20",
				actionsLock: "unlocked",
			},
			{
				id: "1202",
				hostname: "hobo-arc-2.example.test",
				state: "running",
				plan: "KVM 4",
				actionsLock: "locked",
			},
		]);
		expect(wire.calls).toEqual([
			{
				method: "GET",
				path: "/api/vps/v1/virtual-machines",
				authorization: `Bearer ${TOKEN}`,
			},
		]);
		expect(JSON.stringify(machines)).not.toContain(TOKEN);
	});

	it("starts and restarts an owned machine by id or hostname", async () => {
		const wire = fake();
		const fleet = hostingerVpsFleet({
			transport: wire.transport,
			resolveToken: async () => TOKEN,
		});
		const started = await fleet.power("1201", "start");
		const restarted = await fleet.power("hobo-arc-1.example.test", "restart");
		expect(started.actionId).toBe("9001");
		expect(started.actionState).toBe("sent");
		expect(restarted.machine.id).toBe("1201");
		expect(
			wire.calls
				.filter((call) => call.method !== "GET")
				.map((call) => call.path),
		).toEqual([
			"/api/vps/v1/virtual-machines/1201/start",
			"/api/vps/v1/virtual-machines/1201/restart",
		]);
	});

	it("refuses unknown and locked machines before any mutating call", async () => {
		const wire = fake();
		const fleet = hostingerVpsFleet({
			transport: wire.transport,
			resolveToken: async () => TOKEN,
		});
		expect((await failure(() => fleet.power("4040", "start"))).code).toBe(
			"HOSTINGER_FLEET_NO_SUCH_MACHINE",
		);
		expect((await failure(() => fleet.power("1202", "restart"))).code).toBe(
			"HOSTINGER_FLEET_LOCKED",
		);
		expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
	});

	it("refuses billing, purchase, setup and recreate routes before the transport", async () => {
		const wire = fake();
		const guarded = guardedHostingerFleetTransport(wire.transport);
		const attempt = (method: "GET" | "POST" | "DELETE", path: string) =>
			failure(() =>
				guarded({
					method,
					url: `https://developers.hostinger.com${path}`,
					headers: { authorization: `Bearer ${TOKEN}` },
					timeoutMs: 1000,
					maxResponseBytes: 1024,
				}),
			);
		const routes: ReadonlyArray<readonly ["GET" | "POST" | "DELETE", string]> =
			[
				["GET", "/api/billing/v1/orders"],
				["POST", "/api/billing/v1/orders"],
				["POST", "/api/vps/v1/virtual-machines"],
				["POST", "/api/vps/v1/virtual-machines/1201/setup"],
				["POST", "/api/vps/v1/virtual-machines/1201/recreate"],
				["POST", "/api/vps/v1/virtual-machines/1201/stop"],
				["DELETE", "/api/vps/v1/virtual-machines/1201"],
			];
		for (const [method, path] of routes) {
			const refused = await attempt(method, path);
			expect(refused.code).toBe("HOSTINGER_FLEET_ROUTE_REFUSED");
			expect(refused.message).not.toContain(TOKEN);
		}
		expect(wire.calls).toHaveLength(0);
	});

	it("keeps the token out of provider errors", async () => {
		const wire = fake(() =>
			reply(401, { message: `token ${TOKEN} is not valid for this account` }),
		);
		const fleet = hostingerVpsFleet({
			transport: wire.transport,
			resolveToken: async () => TOKEN,
		});
		const refused = await failure(() => fleet.list());
		expect(refused.code).toBe("HOSTINGER_FLEET_REJECTED");
		expect(refused.message).toContain("401");
		expect(refused.message).not.toContain(TOKEN);
	});

	it("accepts only the closed power action vocabulary", () => {
		expect(parseHostingerVmPowerAction("restart")).toBe("restart");
		expect(parseHostingerVmPowerAction("start")).toBe("start");
		expect(parseHostingerVmPowerAction("stop")).toBeUndefined();
		expect(parseHostingerVmPowerAction("purchase")).toBeUndefined();
	});

	it("matches the fleet power interaction the pact records", async () => {
		const interactions = pact.interactions;
		if (!isJsonArray(interactions)) throw new Error("the pact is malformed");
		const interaction = interactions.find(
			(entry) =>
				isJsonObject(entry) &&
				entry.description ===
					"restart an owned VPS by hostname through the fleet, never a purchase route",
		);
		if (!isJsonObject(interaction) || !isJsonObject(interaction.request))
			throw new Error("the pact is missing the fleet power interaction");
		const body = isJsonObject(interaction.request.body)
			? interaction.request.body
			: {};
		const response =
			isJsonObject(interaction.response) &&
			isJsonObject(interaction.response.body)
				? interaction.response.body
				: {};
		const wire = fake();
		const fleet = hostingerVpsFleet({
			transport: wire.transport,
			resolveToken: async () => TOKEN,
		});
		const action = parseHostingerVmPowerAction(
			isJsonString(body.action) ? body.action : "",
		);
		if (action === undefined) throw new Error("the pact names no action");
		const receipt = await fleet.power(
			isJsonString(body.target) ? body.target : "",
			action,
		);
		expect(receipt.machine.id).toBe(response.machineId);
		expect(wire.calls.filter((call) => call.method !== "GET")).toHaveLength(
			isJsonNumber(response.mutatingCalls) ? response.mutatingCalls : -1,
		);
		expect(
			wire.calls.some((call) => call.path.startsWith("/api/billing/")),
		).toBe(false);
	});
});
