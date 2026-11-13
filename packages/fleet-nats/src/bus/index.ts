/**
 * Topology, credentials, auth callout and the bus ports over NATS (L08).
 * Signatures frozen by the fleet contract commit (ADR-0182).
 *
 * Each frozen entry point runs its `…Over` twin on the real client (`NATS`);
 * the twins take the client as a `NatsClients` port, which is how the unit
 * tests run them over a fake server.
 */
import { randomBytes } from "node:crypto";
import type { TenantId } from "@hobo/core";
import type {
	AuthorityBus,
	Clock,
	FleetBusConnector,
	FleetLog,
	Outcome,
	RegistryView,
	ReplayStore,
	SignedEnvelope,
	Subscription,
	TrustRecord,
} from "@hobo/fleet";
import { fromSeed } from "@nats-io/jwt";
import { credsAuthenticator } from "@nats-io/transport-node";
import { answerCallout } from "./callout.js";
import { mintConnectToken } from "./connect-token.js";
import { authorityBusOverWire, busOverWire } from "./fleet-bus.js";
import { NATS, type NatsClients } from "./nats-client.js";
import {
	type AccountSigningKeys,
	accountOfCredentials,
	mintAccount,
	mintAccountWithSigningKeys,
	staticCredentials,
	tenantKeys,
} from "./nats-jwt.js";
import { natsWire } from "./nats-wire.js";
import {
	authorityPin,
	createRegistryView,
	devicePin,
} from "./registry-view.js";
import { pushAccount } from "./resolver.js";
import { applyTopology } from "./topology.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CALLOUT_SUBJECT = "$SYS.REQ.USER.AUTH";

const seedText = (seed: Uint8Array) => decoder.decode(seed);

type ProvisionInput = Readonly<{
	servers: readonly string[];
	operatorSigningSeed: string;
	tenant: TenantId;
	replicas: 1 | 3;
}>;

type Provisioned = Readonly<{
	accountPublicKey: string;
	staticCredentials: Readonly<
		Record<"authority" | "witness" | "provisioner" | "sentinel", string>
	>;
	scopedSeeds: Readonly<Record<"observer" | "executor" | "dispatcher", string>>;
}>;

type AuthorityInput = Readonly<{
	servers: readonly string[];
	credentials: string;
	trust: () => TrustRecord;
	log: FleetLog;
}>;

type CalloutInput = Readonly<{
	servers: readonly string[];
	credentials: string;
	xkeySeed: string;
	scopedSeeds: Readonly<Record<"observer" | "executor" | "dispatcher", string>>;
	registry: RegistryView;
	replay: ReplayStore;
	incarnation: number;
	now: Clock;
	log: FleetLog;
}>;

/** Creates the tenant account, its static users and scoped signing keys, and its streams and buckets. */
export function provisionTopology(
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
	return provisionTopologyOver(NATS, input);
}

/** `provisionTopology` over `clients`. */
export async function provisionTopologyOver(
	clients: NatsClients,
	input: ProvisionInput,
): Promise<Provisioned> {
	const keys = tenantKeys(input.operatorSigningSeed, input.tenant);
	await pushAccount(
		input.servers,
		input.operatorSigningSeed,
		await mintAccount(keys, input.tenant, input.operatorSigningSeed),
		clients,
	);
	const credentials = {
		authority: await staticCredentials(keys, "authority"),
		witness: await staticCredentials(keys, "witness"),
		provisioner: await staticCredentials(keys, "provisioner"),
		sentinel: await staticCredentials(keys, "sentinel"),
	};
	const provisioner = await clients.open({
		servers: input.servers,
		authenticator: credsAuthenticator(encoder.encode(credentials.provisioner)),
		name: "hobo-fleet-provisioner",
		persistent: false,
	});
	try {
		await applyTopology(
			await clients.jetstreamManager(provisioner),
			input.replicas,
		);
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

type SigningKeysInput = Readonly<{
	servers: readonly string[];
	operatorSigningSeed: string;
	tenant: TenantId;
	signingKeys: AccountSigningKeys;
}>;

/**
 * Internal (L41; composed by the authority service and `hobo fleet ops` as
 * the `NatsSigningKeys` of `rotateKey`): re-issues the tenant account JWT
 * listing exactly `signingKeys` and pushes it to the resolver. The caller
 * reads the lists from the secret-store slots `<prefix>/account-signing` and
 * `<prefix>/scoped-<template>`; each step of add, publish, switch, remove is
 * one call with the slots as they then are. `invalid-request` for a key that
 * is not an account public key or is listed twice (nothing is pushed);
 * `unavailable` when the resolver cannot be reached or refuses the account.
 *
 * `provisionTopology` pushes the account with the derived scoped keys only,
 * so after a rotation it must not be re-run without publishing the slots'
 * keys again.
 */
export function publishAccountSigningKeys(
	input: SigningKeysInput,
): Promise<Outcome<Readonly<{ accountPublicKey: string }>>> {
	return publishAccountSigningKeysOver(NATS, input);
}

/** `publishAccountSigningKeys` over `clients`. */
export async function publishAccountSigningKeysOver(
	clients: NatsClients,
	input: SigningKeysInput,
): Promise<Outcome<Readonly<{ accountPublicKey: string }>>> {
	const keys = tenantKeys(input.operatorSigningSeed, input.tenant);
	let jwt: string;
	try {
		jwt = await mintAccountWithSigningKeys(
			keys,
			input.tenant,
			input.operatorSigningSeed,
			input.signingKeys,
		);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: cause instanceof Error ? cause.message : String(cause),
			},
		};
	}
	try {
		await pushAccount(input.servers, input.operatorSigningSeed, jwt, clients);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: `the account was not published: ${cause instanceof Error ? cause.message : String(cause)}`,
			},
		};
	}
	return { ok: true, value: { accountPublicKey: keys.account.getPublicKey() } };
}

/**
 * A device's connection to its tenant's bus. The device presents the public
 * sentinel credentials and a connect token; the token is minted before each
 * connection attempt from a fresh ticket, because the client's authenticator
 * is synchronous and the device's SIGN key signs asynchronously, so the proof
 * cannot carry the server's nonce: each ticket connects once (A2 fallback).
 */
export function createNatsBusConnector(): FleetBusConnector {
	return natsBusConnectorOver(NATS);
}

/** `createNatsBusConnector` over `clients`. */
export function natsBusConnectorOver(clients: NatsClients): FleetBusConnector {
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
			const connection = await clients.open({
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
			const wire = natsWire(
				connection,
				{
					consumerName: () => keys.memberId,
					onStatus(status) {
						log("hobo_fleet_bus_status", { status, member: keys.memberId });
						void prepare();
					},
				},
				clients,
			);
			const registry = createRegistryView({ wire, pin, now: Date.now });
			return busOverWire(wire, registry);
		},
	};
}

/** The authority's connection; positions are per subscription (`BusStart`). */
export function connectAuthorityBus(
	input: Readonly<{
		servers: readonly string[];
		credentials: string;
		trust: () => TrustRecord;
		log: FleetLog;
	}>,
): Promise<AuthorityBus> {
	return authorityBusOver(NATS, input);
}

/** `connectAuthorityBus` over `clients`. */
export async function authorityBusOver(
	clients: NatsClients,
	input: AuthorityInput,
): Promise<AuthorityBus> {
	const connection = await clients.open({
		servers: input.servers,
		authenticator: credsAuthenticator(encoder.encode(input.credentials)),
		name: "hobo-fleet-authority",
		persistent: true,
	});
	const wire = natsWire(
		connection,
		{
			consumerName: () => `authority_${randomBytes(8).toString("hex")}`,
			onStatus: (status) => input.log("hobo_fleet_bus_status", { status }),
		},
		clients,
	);
	const pin = authorityPin(input.trust);
	const registry = createRegistryView({ wire, pin, now: Date.now });
	await registry.caughtUp();
	return authorityBusOverWire(wire, registry, pin, Date.now);
}

/** Answers NATS auth callouts with user credentials scoped to the member. */
export function startCalloutResponder(
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
	return calloutResponderOver(NATS, input);
}

/** `startCalloutResponder` over `clients`. */
export async function calloutResponderOver(
	clients: NatsClients,
	input: CalloutInput,
): Promise<Subscription> {
	const connection = await clients.open({
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
