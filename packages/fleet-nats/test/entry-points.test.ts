/**
 * The four entry points of `src/bus/index.ts` and the resolver push. Each
 * runs over the fake server of `support/fake-nats.ts` through its `…Over`
 * twin, which takes the client as a port; the frozen entry points themselves
 * run on the real client against a port nothing listens on. The integration
 * tests run the same entry points against `nats-server`.
 */
import { type AddressInfo, createServer as listen } from "node:net";
import { create } from "@bufbuild/protobuf";
import type { TenantId } from "@hobo/core";
import { DiscoverySchema, type FleetLog, Role } from "@hobo/fleet";
import {
	type Account,
	type ClaimsData,
	createAccount,
	createCurve,
	createOperator,
	createServer,
	createUser,
	decode,
	encode,
	fromSeed,
} from "@nats-io/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import { mintConnectToken } from "../src/bus/connect-token.js";
import {
	authorityBusOver,
	calloutResponderOver,
	connectAuthorityBus,
	createNatsBusConnector,
	natsBusConnectorOver,
	provisionTopology,
	provisionTopologyOver,
	publishAccountSigningKeys,
	publishAccountSigningKeysOver,
	startCalloutResponder,
} from "../src/bus/index.js";
import { staticCredentials, tenantKeys } from "../src/bus/nats-jwt.js";
import { pushAccount } from "../src/bus/resolver.js";
import { topologySpecs } from "../src/bus/topology.js";
import {
	acceptAccounts,
	createFakeServer,
	type FakeServer,
} from "./support/fake-nats.js";
import { createTenant } from "./support/fixture.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// SAFETY: a literal tenant id for the tests.
const TENANT = "acme" as TenantId;
const SERVERS = ["tls://127.0.0.1:4222"];

let server: FakeServer = createFakeServer();
let operatorSigningSeed = "";

beforeEach(() => {
	server = createFakeServer();
	operatorSigningSeed = decoder.decode(createOperator().getSeed());
});

/** A local URL nothing listens on: a port the OS handed out and took back. */
async function closedServer(): Promise<string> {
	const probe = listen();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
	const { port } = probe.address() as AddressInfo;
	await new Promise((resolve) => probe.close(resolve));
	return `tls://127.0.0.1:${port}`;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function provision() {
	acceptAccounts(server);
	return provisionTopologyOver(server.clients, {
		servers: SERVERS,
		operatorSigningSeed,
		tenant: TENANT,
		replicas: 1,
	});
}

function scopedSeedsOf(keys: ReturnType<typeof tenantKeys>) {
	return {
		observer: decoder.decode(keys.scoped.observer.getSeed()),
		executor: decoder.decode(keys.scoped.executor.getSeed()),
		dispatcher: decoder.decode(keys.scoped.dispatcher.getSeed()),
	};
}

describe("provisionTopology", () => {
	it("pushes the account, creates every stream, and is idempotent", async () => {
		const pushed = acceptAccounts(server);
		const input = {
			servers: SERVERS,
			operatorSigningSeed,
			tenant: TENANT,
			replicas: 1,
		} as const;
		const first = await provisionTopologyOver(server.clients, input);
		const keys = tenantKeys(operatorSigningSeed, TENANT);
		expect(first.accountPublicKey).toBe(keys.account.getPublicKey());
		expect(Object.keys(first.staticCredentials).sort()).toEqual([
			"authority",
			"provisioner",
			"sentinel",
			"witness",
		]);
		expect(first.scopedSeeds).toEqual(scopedSeedsOf(keys));
		expect(server.streamNames().sort()).toEqual(
			topologySpecs(1)
				.map((spec) => spec.name)
				.sort(),
		);
		const second = await provisionTopologyOver(server.clients, input);
		expect(second.accountPublicKey).toBe(first.accountPublicKey);
		expect(second.scopedSeeds).toEqual(first.scopedSeeds);
		expect(pushed).toHaveLength(2);
		expect(
			server.connections.every((connection) => connection.isClosed()),
		).toBe(true);
		expect(server.opened.map((open) => open.name)).toEqual([
			"hobo-fleet-provision",
			"hobo-fleet-provisioner",
			"hobo-fleet-provision",
			"hobo-fleet-provisioner",
		]);
	});
});

describe("provisionTopology after a rotation (L42)", () => {
	const signingOf = (jwt: string | undefined) => {
		const claims: ClaimsData<Account> = decode(jwt ?? "");
		return (claims.nats.signing_keys ?? []).map((key) =>
			key instanceof Object ? `${key.role}:${key.key}` : key,
		);
	};
	const input = () =>
		({
			servers: SERVERS,
			operatorSigningSeed,
			tenant: TENANT,
			replicas: 1,
		}) as const;

	it("keeps the signing keys the resolver holds instead of the derived ones", async () => {
		const pushed = acceptAccounts(server);
		const rotatedSigning = createAccount().getPublicKey();
		const rotatedExecutor = createAccount().getPublicKey();
		const keys = tenantKeys(operatorSigningSeed, TENANT);
		await provisionTopologyOver(server.clients, input());
		expect(signingOf(pushed.at(-1))).toEqual([
			`observer:${keys.scoped.observer.getPublicKey()}`,
			`executor:${keys.scoped.executor.getPublicKey()}`,
			`dispatcher:${keys.scoped.dispatcher.getPublicKey()}`,
		]);
		const rotated = await publishAccountSigningKeysOver(server.clients, {
			servers: SERVERS,
			operatorSigningSeed,
			tenant: TENANT,
			signingKeys: {
				account: [rotatedSigning],
				scoped: {
					observer: [keys.scoped.observer.getPublicKey()],
					executor: [rotatedExecutor],
					dispatcher: [keys.scoped.dispatcher.getPublicKey()],
				},
			},
		});
		expect(rotated.ok).toBe(true);
		const afterRotation = signingOf(pushed.at(-1));
		await provisionTopologyOver(server.clients, input());
		expect(signingOf(pushed.at(-1))).toEqual(afterRotation);
		expect(afterRotation).toEqual([
			rotatedSigning,
			`observer:${keys.scoped.observer.getPublicKey()}`,
			`executor:${rotatedExecutor}`,
			`dispatcher:${keys.scoped.dispatcher.getPublicKey()}`,
		]);
	});

	it("lists the signing keys it is given, from the internal options", async () => {
		const pushed = acceptAccounts(server);
		const given = createAccount().getPublicKey();
		await provisionTopologyOver(server.clients, input(), {
			signingKeys: {
				account: [],
				scoped: { observer: [given], executor: [], dispatcher: [] },
			},
		});
		expect(signingOf(pushed.at(-1))).toEqual([`observer:${given}`]);
	});

	it("pushes nothing when the resolver's answer is not this account's JWT", async () => {
		const pushed = acceptAccounts(server);
		server.reply("$SYS.REQ.ACCOUNT.*.CLAIMS.LOOKUP", () =>
			encoder.encode("not a jwt"),
		);
		await expect(
			provisionTopologyOver(server.clients, input()),
		).rejects.toThrow(/does not decode/u);
		expect(pushed).toEqual([]);
	});
});

describe("publishAccountSigningKeys (L41: account-signing and scoped-* rotation)", () => {
	const accountKey = () => createAccount().getPublicKey();
	const signingOf = (jwt: string | undefined) => {
		const claims: ClaimsData<Account> = decode(jwt ?? "");
		return (claims.nats.signing_keys ?? []).map((key) =>
			key instanceof Object ? `${key.role}:${key.key}` : key,
		);
	};

	it("re-issues and pushes the account with the supplied keys, each step of add, publish, switch, remove", async () => {
		const pushed = acceptAccounts(server);
		const keys = tenantKeys(operatorSigningSeed, TENANT);
		const derived = {
			observer: [keys.scoped.observer.getPublicKey()],
			executor: [keys.scoped.executor.getPublicKey()],
			dispatcher: [keys.scoped.dispatcher.getPublicKey()],
		};
		const oldSigning = accountKey();
		const newSigning = accountKey();
		const newExecutor = accountKey();
		const publish = (account: readonly string[], scoped: typeof derived) =>
			publishAccountSigningKeysOver(server.clients, {
				servers: SERVERS,
				operatorSigningSeed,
				tenant: TENANT,
				signingKeys: { account, scoped },
			});
		// Publish: old and new side by side.
		expect(
			await publish([oldSigning, newSigning], {
				...derived,
				executor: [...derived.executor, newExecutor],
			}),
		).toEqual({
			ok: true,
			value: { accountPublicKey: keys.account.getPublicKey() },
		});
		// Remove: only the new ones.
		await publish([newSigning], { ...derived, executor: [newExecutor] });
		expect(pushed).toHaveLength(2);
		expect(signingOf(pushed[0])).toEqual([
			oldSigning,
			newSigning,
			`observer:${derived.observer[0]}`,
			`executor:${derived.executor[0]}`,
			`executor:${newExecutor}`,
			`dispatcher:${derived.dispatcher[0]}`,
		]);
		expect(signingOf(pushed[1])).toEqual([
			newSigning,
			`observer:${derived.observer[0]}`,
			`executor:${newExecutor}`,
			`dispatcher:${derived.dispatcher[0]}`,
		]);
		const claims: ClaimsData<Account> = decode(pushed[1] ?? "");
		expect(claims.sub).toBe(keys.account.getPublicKey());
		expect(claims.iss).toBe(
			fromSeed(encoder.encode(operatorSigningSeed)).getPublicKey(),
		);
		expect(
			server.connections.every((connection) => connection.isClosed()),
		).toBe(true);
	});

	it("refuses a malformed key list with invalid-request and pushes nothing", async () => {
		const pushed = acceptAccounts(server);
		const outcome = await publishAccountSigningKeysOver(server.clients, {
			servers: SERVERS,
			operatorSigningSeed,
			tenant: TENANT,
			signingKeys: {
				account: ["not-a-key"],
				scoped: { observer: [], executor: [], dispatcher: [] },
			},
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("invalid-request");
		expect(pushed).toHaveLength(0);
	});

	it("answers unavailable when the resolver refuses the account or cannot be reached", async () => {
		server.reply("$SYS.REQ.CLAIMS.UPDATE", () =>
			encoder.encode(JSON.stringify({ error: { description: "bad jwt" } })),
		);
		const input = {
			servers: SERVERS,
			operatorSigningSeed,
			tenant: TENANT,
			signingKeys: {
				account: [],
				scoped: { observer: [], executor: [], dispatcher: [] },
			},
		};
		const refused = await publishAccountSigningKeysOver(server.clients, input);
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.error.code).toBe("unavailable");
			expect(refused.error.message).toContain("bad jwt");
		}
		const unreachable = await publishAccountSigningKeys({
			...input,
			servers: [await closedServer()],
		});
		expect(unreachable.ok).toBe(false);
		if (!unreachable.ok) expect(unreachable.error.code).toBe("unavailable");
	});
});

describe("pushAccount", () => {
	it("passes on the resolver's refusal, with or without a description", async () => {
		server.reply("$SYS.REQ.CLAIMS.UPDATE", () =>
			encoder.encode(JSON.stringify({ error: { description: "bad jwt" } })),
		);
		await expect(
			pushAccount(SERVERS, operatorSigningSeed, "jwt", server.clients),
		).rejects.toThrow("the resolver refused the account: bad jwt");
		server.reply("$SYS.REQ.CLAIMS.UPDATE", () =>
			encoder.encode(JSON.stringify({ error: {} })),
		);
		await expect(
			pushAccount(SERVERS, operatorSigningSeed, "jwt", server.clients),
		).rejects.toThrow("the resolver refused the account: unknown");
		expect(
			server.connections.every((connection) => connection.isClosed()),
		).toBe(true);
	});
});

describe("connectAuthorityBus", () => {
	it("connects with the authority's credentials and logs status changes", async () => {
		const provisioned = await provision();
		const logged: Parameters<FleetLog>[] = [];
		const bus = await authorityBusOver(server.clients, {
			servers: SERVERS,
			credentials: provisioned.staticCredentials.authority,
			trust: () => {
				throw new Error("no trust record published yet");
			},
			log: (event, fields) => logged.push([event, fields]),
		});
		expect(bus.status()).toBe("connected");
		expect(server.opened.at(-1)?.name).toBe("hobo-fleet-authority");
		server.connections.at(-1)?.emit("disconnect");
		await settle();
		expect(logged).toEqual([
			["hobo_fleet_bus_status", { status: "disconnected" }],
		]);
		await bus.close();
	});
});

describe("createNatsBusConnector", () => {
	it("connects a device with the sentinel and a fresh connect token per attempt", async () => {
		const provisioned = await provision();
		const tenant = await createTenant();
		const keys = await tenant.device({ roles: [Role.EXECUTOR] });
		let tickets = 0;
		const logged: Parameters<FleetLog>[] = [];
		const bus = await natsBusConnectorOver(server.clients).connect({
			discovery: create(DiscoverySchema, {
				tenant: TENANT,
				natsUrls: SERVERS,
				natsSentinelCredentials: provisioned.staticCredentials.sentinel,
				trust: tenant.trust,
			}),
			keys,
			trust: tenant.trust,
			ticket: async () => {
				tickets += 1;
				if (tickets === 3) throw new Error("authority unreachable");
				if (tickets === 4) throw "not an error";
				return tenant.ticket(keys);
			},
			resumeFrom: {},
			log: (event, fields) => logged.push([event, fields]),
		});
		const device = server.opened.at(-1);
		expect(device?.name).toBe(keys.memberId);
		expect(device?.authTokens).toHaveLength(2);
		expect(device?.authTokens[0]).toBeUndefined();
		expect(device?.authTokens[1]?.length).toBeGreaterThan(0);
		await settle();
		expect(tickets).toBe(2);
		const connection = server.connections.at(-1);
		connection?.emit("disconnect");
		await settle();
		await settle();
		connection?.emit("reconnect");
		await settle();
		await settle();
		expect(tickets).toBe(4);
		expect(logged).toContainEqual([
			"hobo_fleet_bus_status",
			{ status: "disconnected", member: keys.memberId },
		]);
		expect(logged).toContainEqual([
			"hobo_fleet_bus_status",
			{ status: "ticket-unavailable", reason: "authority unreachable" },
		]);
		expect(logged).toContainEqual([
			"hobo_fleet_bus_status",
			{ status: "ticket-unavailable", reason: "unknown" },
		]);
		expect(bus.status()).toBe("connected");
		await bus.close();
		expect(bus.status()).toBe("closed");
	});
});

describe("startCalloutResponder", () => {
	async function sealedRequest(
		token: string,
		accountXkey: string,
		serverXkey: ReturnType<typeof createCurve>,
	) {
		const identity = createServer();
		const jwt = await encode(
			// SAFETY: the jwt package's algorithm enum value for v2 JWTs.
			"ed25519-nkey" as Parameters<typeof encode>[0],
			{
				aud: "nats-authorization-request",
				jti: "r1",
				iat: 1,
				iss: identity.getPublicKey(),
				name: "",
				sub: identity.getPublicKey(),
				nats: {
					server_id: { id: identity.getPublicKey(), name: "n1", host: "h" },
					user_nkey: createUser().getPublicKey(),
					client_info: { nonce: "n-1" },
					connect_opts: { protocol: 1, auth_token: token },
					type: "authorization_request",
					version: 2,
				},
			},
			identity,
		);
		return serverXkey.seal(encoder.encode(jwt), accountXkey);
	}

	it("answers a sealed request and stays silent on one it cannot open", async () => {
		const tenant = await createTenant();
		const keys = tenantKeys(operatorSigningSeed, TENANT);
		const logged: string[] = [];
		const responder = await calloutResponderOver(server.clients, {
			servers: SERVERS,
			credentials: await staticCredentials(keys, "authority"),
			xkeySeed: decoder.decode(keys.xkey.getSeed()),
			scopedSeeds: scopedSeedsOf(keys),
			registry: tenant.bus.registry,
			replay: tenant.bus.replay,
			incarnation: 3,
			now: tenant.now,
			log: (event, fields) =>
				logged.push(
					`${event} ${String(fields.check ?? `${fields.status} ${fields.member}`)}`,
				),
		});
		expect(server.opened.at(-1)?.name).toBe("hobo-fleet-callout");
		const client = server.connect("server");
		const device = await tenant.device({ roles: [Role.EXECUTOR] });
		const token = await mintConnectToken(device, await tenant.ticket(device));
		const serverXkey = createCurve();
		const reply = await client.ask(
			"$SYS.REQ.USER.AUTH",
			await sealedRequest(token, keys.xkey.getPublicKey(), serverXkey),
			{ "Nats-Server-Xkey": serverXkey.getPublicKey() },
		);
		expect(
			serverXkey.open(reply.data, keys.xkey.getPublicKey()),
		).not.toBeNull();
		await expect(
			client.ask("$SYS.REQ.USER.AUTH", new Uint8Array([1, 2, 3]), {}),
		).rejects.toThrow(/no responders/u);
		expect(logged).toEqual([
			`hobo_fleet_bus_status authorised ${device.memberId}`,
			"hobo_fleet_callout_refused request-signature",
		]);
		await responder.stop();
		await client.close();
	});
});

describe("the entry points on the real client", () => {
	it("each refuses when no server answers", async () => {
		const servers = [await closedServer()];
		const keys = tenantKeys(operatorSigningSeed, TENANT);
		const credentials = await staticCredentials(keys, "authority");
		const tenant = await createTenant();
		const device = await tenant.device();
		const log: FleetLog = () => undefined;
		await expect(
			provisionTopology({
				servers,
				operatorSigningSeed,
				tenant: TENANT,
				replicas: 1,
			}),
		).rejects.toThrow();
		await expect(
			connectAuthorityBus({
				servers,
				credentials,
				trust: () => tenant.bus.registry.trust(),
				log,
			}),
		).rejects.toThrow();
		await expect(
			startCalloutResponder({
				servers,
				credentials,
				xkeySeed: decoder.decode(keys.xkey.getSeed()),
				scopedSeeds: scopedSeedsOf(keys),
				registry: tenant.bus.registry,
				replay: tenant.bus.replay,
				incarnation: 3,
				now: tenant.now,
				log,
			}),
		).rejects.toThrow();
		await expect(
			createNatsBusConnector().connect({
				discovery: create(DiscoverySchema, {
					tenant: TENANT,
					natsUrls: servers,
					natsSentinelCredentials: credentials,
					trust: tenant.trust,
				}),
				keys: device,
				trust: tenant.trust,
				ticket: () => tenant.ticket(device),
				resumeFrom: {},
				log,
			}),
		).rejects.toThrow();
	});
});
