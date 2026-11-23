import { createHoboCli } from "@hobo/cli";
import type { HttpTransport, TransportResponse } from "@hobo/core";
import type { OwnerStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { createCiCommand } from "../src/ci-command.js";
import {
	createOwnerStoreSessions,
	type OwnerStoreSessions,
} from "../src/owner-store-session.js";

const TOKEN = "synthetic-hostinger-fleet-token-0123456789";
const PRIVATE_PROJECT = "synthetic-private-fleet-project";
const CWD = "/synthetic/fleet-project";

type Call = Readonly<{ method: string; path: string }>;

type WireRecord = Readonly<Record<string, string | number>>;

interface FakeHostinger {
	readonly transport: HttpTransport;
	readonly calls: Call[];
}

function reply(
	status: number,
	payload: WireRecord | readonly WireRecord[],
): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	};
}

function hostinger(
	answer: (method: string, path: string) => TransportResponse = (
		method,
		path,
	) => {
		if (method === "GET" && path === "/api/vps/v1/virtual-machines")
			return reply(200, [
				{
					id: 3301,
					hostname: "hobo-arc.example.test",
					state: "stopped",
					plan: "KVM 2",
					actions_lock: "unlocked",
					subscription_id: "synthetic-subscription",
				},
			]);
		if (
			method === "POST" &&
			/^\/api\/vps\/v1\/virtual-machines\/3301\/(?:restart|start)$/u.test(path)
		)
			return reply(200, { id: 77, name: "start", state: "sent" });
		return reply(500, { message: "unexpected" });
	},
): FakeHostinger {
	const calls: Call[] = [];
	return {
		calls,
		transport: async (request) => {
			const path = new URL(request.url).pathname;
			calls.push({ method: request.method, path });
			return answer(request.method, path);
		},
	};
}

async function session(
	entries: Readonly<Record<string, string>>,
): Promise<OwnerStoreSessions> {
	const port = createMemorySecretsPort({ id: `store:${PRIVATE_PROJECT}` });
	for (const [name, value] of Object.entries(entries))
		await port.put(name, value);
	const owner: OwnerStore = {
		id: "infisical",
		chosen: true,
		missing: [],
		canAwaitEgressCredential: false,
		egressCredentialHost: undefined,
		opened: {
			id: "infisical",
			port,
			reference: (name) => `infisical://${PRIVATE_PROJECT}/prod/${name}`,
		},
		infisicalFolder: undefined,
		unopened: undefined,
		stage: async () => {
			throw new Error("the fleet never stages a page");
		},
	};
	const sessions = createOwnerStoreSessions({
		signIn: async () => ({ kind: "owner", owner }),
	});
	await sessions.establish(CWD);
	return sessions;
}

function cli(
	sessions: OwnerStoreSessions | undefined,
	transport: HttpTransport,
) {
	return createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {},
				...(sessions !== undefined
					? { fleetCredentials: sessions.credentials }
					: undefined),
				hostingerHttp: transport,
			}),
		},
	});
}

function leaksNothing(text: string): void {
	expect(text).not.toContain(TOKEN);
	expect(text).not.toContain(PRIVATE_PROJECT);
	expect(text).not.toContain("infisical://");
	expect(text).not.toContain("synthetic-subscription");
}

describe("hobo ci fleet", () => {
	it("lists the Hostinger fleet with the owner session's token", async () => {
		const wire = hostinger();
		const result = await cli(
			await session({ HOSTINGER_API_TOKEN: TOKEN }),
			wire.transport,
		).run(["ci", "fleet", "status", "--json"], { cwd: CWD });
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data.fleet).toEqual({
			provider: "hostinger",
			hosts: [
				{
					provider: "hostinger",
					id: "3301",
					hostname: "hobo-arc.example.test",
					state: "stopped",
					plan: "KVM 2",
					ipv4: "",
					actionsLock: "unlocked",
				},
			],
		});
		expect(wire.calls).toEqual([
			{ method: "GET", path: "/api/vps/v1/virtual-machines" },
		]);
		leaksNothing(result.stdout + result.stderr);
	});

	it.each([
		"start",
		"restart",
	])("%ss an owned machine by hostname", async (action) => {
		const wire = hostinger();
		const result = await cli(
			await session({ HOSTINGER_API_TOKEN: TOKEN }),
			wire.transport,
		).run(["ci", "fleet", action, "hobo-arc.example.test", "--json"], {
			cwd: CWD,
		});
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data.fleetAction).toMatchObject({
			provider: "hostinger",
			action,
			actionId: "77",
			actionState: "sent",
			host: { id: "3301" },
		});
		expect(wire.calls.filter((call) => call.method === "POST")).toEqual([
			{
				method: "POST",
				path: `/api/vps/v1/virtual-machines/3301/${action}`,
			},
		]);
		leaksNothing(result.stdout + result.stderr);
	});

	it("refuses without a token, naming only the reference and choose_secret_store", async () => {
		for (const sessions of [undefined, await session({})]) {
			const wire = hostinger();
			const result = await cli(sessions, wire.transport).run(
				["ci", "fleet", "status", "--json"],
				{ cwd: CWD },
			);
			expect(result.exitCode).not.toBe(0);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.code).toBe("HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE");
			expect(envelope.message).toContain("owner://HOSTINGER_API_TOKEN");
			expect(envelope.message).toContain("choose_secret_store");
			expect(wire.calls).toEqual([]);
			leaksNothing(result.stdout + result.stderr);
		}
	});

	it("keeps the token out of provider errors", async () => {
		const wire = hostinger(() =>
			reply(401, { message: `Bearer ${TOKEN} was rejected` }),
		);
		const result = await cli(
			await session({ HOSTINGER_API_TOKEN: TOKEN }),
			wire.transport,
		).run(["ci", "fleet", "restart", "3301", "--json"], { cwd: CWD });
		expect(result.exitCode).not.toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.code).toBe("HOSTINGER_FLEET_REJECTED");
		expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
		leaksNothing(result.stdout + result.stderr);
	});

	it.each([
		[["ci", "fleet", "purchase", "3301"]],
		[["ci", "fleet", "stop", "3301"]],
		[["ci", "fleet", "restart"]],
		[["ci", "fleet", "start", "../billing/v1/orders"]],
		[["ci", "fleet", "status", "extra"]],
	])("refuses %j before any Hostinger call", async (args) => {
		const wire = hostinger();
		const result = await cli(
			await session({ HOSTINGER_API_TOKEN: TOKEN }),
			wire.transport,
		).run([...args, "--json"], { cwd: CWD });
		expect(result.exitCode).not.toBe(0);
		expect(JSON.parse(result.stdout).code).toBe("HOBO_CLI_USAGE");
		expect(wire.calls).toEqual([]);
	});

	it("refuses a machine the account does not own instead of buying one", async () => {
		const wire = hostinger();
		const result = await cli(
			await session({ HOSTINGER_API_TOKEN: TOKEN }),
			wire.transport,
		).run(["ci", "fleet", "start", "new-runner.example.test", "--json"], {
			cwd: CWD,
		});
		expect(JSON.parse(result.stdout).code).toBe(
			"HOSTINGER_FLEET_NO_SUCH_MACHINE",
		);
		expect(wire.calls.every((call) => call.method === "GET")).toBe(true);
		expect(wire.calls.some((call) => call.path.includes("billing"))).toBe(
			false,
		);
	});
});
