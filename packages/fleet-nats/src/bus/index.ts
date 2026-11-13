/**
 * Topology, credentials, auth callout and the bus ports over NATS (L08).
 * Signatures frozen by the fleet contract commit (ADR-0182).
 */
import { randomBytes } from "node:crypto";
import type { TenantId } from "@hobo/core";
import type {
	AuthorityBus,
	Clock,
	FleetBusConnector,
	FleetLog,
	RegistryView,
	ReplayStore,
	SignedEnvelope,
	Subscription,
	TrustRecord,
} from "@hobo/fleet";
import { jetstreamManager } from "@nats-io/jetstream";
import { fromSeed } from "@nats-io/jwt";
import {
	credsAuthenticator,
	type NatsConnection,
} from "@nats-io/transport-node";
import { answerCallout } from "./callout.js";
import { mintConnectToken } from "./connect-token.js";
import { open } from "./connection.js";
import { authorityBusOverWire, busOverWire } from "./fleet-bus.js";
import {
	accountOfCredentials,
	mintAccount,
	staticCredentials,
	systemCredentials,
	tenantKeys,
} from "./nats-jwt.js";
import { natsWire } from "./nats-wire.js";
import {
	authorityPin,
	createRegistryView,
	devicePin,
} from "./registry-view.js";
import { applyTopology } from "./topology.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

const seedText = (seed: Uint8Array) => decoder.decode(seed);

/** Pushes an account JWT to the full resolver as the system-account provisioning user. */
async function pushAccount(
	servers: readonly string[],
	operatorSigningSeed: string,
	accountJwt: string,
): Promise<void> {
	const system = await open({
		servers,
		authenticator: credsAuthenticator(
			encoder.encode(await systemCredentials(operatorSigningSeed)),
		),
		name: "hobo-fleet-provision",
		persistent: false,
	});
	try {
		const reply = await system.request(
			"$SYS.REQ.CLAIMS.UPDATE",
			encoder.encode(accountJwt),
			{ timeout: 10_000 },
		);
		const answer: { error?: { description?: string } } = reply.json();
		if (answer.error !== undefined)
			throw new Error(
				`the resolver refused the account: ${answer.error.description ?? "unknown"}`,
			);
	} finally {
		await system.close();
	}
}

/** Creates the tenant account, its static users and scoped signing keys, and its streams and buckets. */
export async function provisionTopology(
	input: Readonly<{
		servers: readonly string[];
		operatorSigningSeed: string;
		tenant: TenantId;
		replicas: 1 | 3;
	}>,
): Promise<
	Readonly<{
		accountPublicKey: string;
		staticCredentials: Readonly<
			Record<"authority" | "witness" | "provisioner" | "sentinel", string>
		>;
		scopedSeeds: Readonly<
			Record<"observer" | "executor" | "dispatcher", string>
		>;
	}>
> {
	const keys = tenantKeys(input.operatorSigningSeed, input.tenant);
	await pushAccount(
		input.servers,
		input.operatorSigningSeed,
		await mintAccount(keys, input.tenant, input.operatorSigningSeed),
	);
	const credentials = {
		authority: await staticCredentials(keys, "authority"),
		witness: await staticCredentials(keys, "witness"),
		provisioner: await staticCredentials(keys, "provisioner"),
		sentinel: await staticCredentials(keys, "sentinel"),
	};
	const provisioner = await open({
		servers: input.servers,
		authenticator: credsAuthenticator(encoder.encode(credentials.provisioner)),
		name: "hobo-fleet-provisioner",
		persistent: false,
	});
	try {
		await applyTopology(await jetstreamManager(provisioner), input.replicas);
	} finally {
		await provisioner.close();
	}
	return {
		accountPublicKey: keys.account.getPublicKey(),
		staticCredentials: credentials,
		scopedSeeds: {
			observer: seedText(keys.scoped.observer.getSeed()),
			executor: seedText(keys.scoped.executor.getSeed()),
			dispatcher: seedText(keys.scoped.dispatcher.getSeed()),
		},
	};
}

/**
 * A device's connection to its tenant's bus. The device presents the public
 * sentinel credentials and a connect token; the token is minted before each
 * connection attempt from a fresh ticket, because the client's authenticator
 * is synchronous and the device's SIGN key signs asynchronously, so the proof
 * cannot carry the server's nonce: each ticket connects once (A2 fallback).
 */
export function createNatsBusConnector(): FleetBusConnector {
	return {
		async connect(input) {
			const { discovery, keys, log } = input;
			const pin = devicePin(input.trust, log);
			let token = "";
			let preparing: Promise<void> | undefined;
			const prepare = () => {
				preparing ??= (async () => {
					try {
						const ticket: SignedEnvelope = await input.ticket();
						token = await mintConnectToken(keys, ticket);
					} catch (error) {
						log("hobo_fleet_bus_status", {
							status: "ticket-unavailable",
							reason: error instanceof Error ? error.message : "unknown",
						});
					} finally {
						preparing = undefined;
					}
				})();
				return preparing;
			};
			await prepare();
			const connection = await open({
				servers: discovery.natsUrls,
				authenticator: [
					credsAuthenticator(encoder.encode(discovery.natsSentinelCredentials)),
					() => ({ auth_token: token }),
				],
				name: keys.memberId,
				inboxPrefix: `_INBOX.${keys.memberId}`,
				persistent: true,
			});
			void prepare();
			const wire = natsWire(connection, {
				consumerName: () => keys.memberId,
				onStatus(status) {
					log("hobo_fleet_bus_status", { status, member: keys.memberId });
					void prepare();
				},
			});
			const registry = createRegistryView({ wire, pin, now: Date.now });
			return busOverWire(wire, registry);
		},
	};
}

/** The authority's connection; positions are per subscription (`BusStart`). */
export async function connectAuthorityBus(
	input: Readonly<{
		servers: readonly string[];
		credentials: string;
		trust: () => TrustRecord;
		log: FleetLog;
	}>,
): Promise<AuthorityBus> {
	const connection = await open({
		servers: input.servers,
		authenticator: credsAuthenticator(encoder.encode(input.credentials)),
		name: "hobo-fleet-authority",
		persistent: true,
	});
	const wire = natsWire(connection, {
		consumerName: () => `authority_${randomBytes(8).toString("hex")}`,
		onStatus: (status) => input.log("hobo_fleet_bus_status", { status }),
	});
	const pin = authorityPin(input.trust);
	const registry = createRegistryView({ wire, pin, now: Date.now });
	await registry.caughtUp();
	return authorityBusOverWire(wire, registry, pin, Date.now);
}

/** Answers NATS auth callouts with user credentials scoped to the member. */
export async function startCalloutResponder(
	input: Readonly<{
		servers: readonly string[];
		credentials: string;
		xkeySeed: string;
		scopedSeeds: Readonly<
			Record<"observer" | "executor" | "dispatcher", string>
		>;
		registry: RegistryView;
		replay: ReplayStore;
		incarnation: number;
		now: Clock;
		log: FleetLog;
	}>,
): Promise<Subscription> {
	const connection: NatsConnection = await open({
		servers: input.servers,
		authenticator: credsAuthenticator(encoder.encode(input.credentials)),
		name: "hobo-fleet-callout",
		persistent: true,
	});
	const deps = {
		xkey: fromSeed(encoder.encode(input.xkeySeed)),
		accountPublicKey: accountOfCredentials(input.credentials),
		scopedSeeds: input.scopedSeeds,
		registry: input.registry,
		replay: input.replay,
		incarnation: input.incarnation,
		now: input.now,
		log: input.log,
	};
	const subscription = connection.subscribe(CALLOUT_SUBJECT);
	const running = (async () => {
		for await (const message of subscription) {
			const answer = await answerCallout(
				message.data,
				message.headers?.get("Nats-Server-Xkey"),
				deps,
			).catch(() => undefined);
			if (answer !== undefined) message.respond(answer);
		}
	})();
	running.catch(() => undefined);
	return {
		async stop() {
			subscription.unsubscribe();
			await running.catch(() => undefined);
			await connection.close();
		},
	};
}
