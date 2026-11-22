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
	auditRoleOfCredentials,
	mintAccount,
	mintAccountWithSigningKeys,
	signingKeysOfAccountJwt,
	staticCredentials,
	tenantKeys,
} from "./nats-jwt.js";
import { natsWire } from "./nats-wire.js";
import {
	authorityPin,
	createRegistryView,
	devicePin,
} from "./registry-view.js";
import { pushAccount, pushAccountOver } from "./resolver.js";
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

export type ProvisionOptions = Readonly<{
	signingKeys?: AccountSigningKeys;
}>;

export async function provisionTopologyOver(
	clients: NatsClients,
	input: ProvisionInput,
	options: ProvisionOptions = {},
): Promise<Provisioned> {
	const keys = tenantKeys(input.operatorSigningSeed, input.tenant);
	const mint = (signing: AccountSigningKeys | undefined) =>
		signing === undefined
			? mintAccount(keys, input.tenant, input.operatorSigningSeed)
			: mintAccountWithSigningKeys(
					keys,
					input.tenant,
					input.operatorSigningSeed,
					signing,
				);
	const supplied = options.signingKeys;
	if (supplied !== undefined)
		await pushAccount(
			input.servers,
			input.operatorSigningSeed,
			await mint(supplied),
			clients,
		);
	else
		await pushAccountOver(
			input.servers,
			input.operatorSigningSeed,
			keys.account.getPublicKey(),
			(published) =>
				mint(
					published === undefined
						? undefined
						: signingKeysOfAccountJwt(published, keys.account.getPublicKey()),
				),
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

export function publishAccountSigningKeys(
	input: SigningKeysInput,
): Promise<Outcome<Readonly<{ accountPublicKey: string }>>> {
	return publishAccountSigningKeysOver(NATS, input);
}

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

export function createNatsBusConnector(): FleetBusConnector {
	return natsBusConnectorOver(NATS);
}

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

export async function authorityBusOver(
	clients: NatsClients,
	input: AuthorityInput,
): Promise<AuthorityBus> {
	const role = auditRoleOfCredentials(input.credentials);
	const connection = await clients.open({
		servers: input.servers,
		authenticator: credsAuthenticator(encoder.encode(input.credentials)),
		name: `hobo-fleet-${role}`,
		persistent: true,
	});
	const wire = natsWire(
		connection,
		{
			consumerName: () => `${role}_${randomBytes(8).toString("hex")}`,
			onStatus: (status) => input.log("hobo_fleet_bus_status", { status }),
		},
		clients,
	);
	const pin = authorityPin(input.trust);
	const registry = createRegistryView({ wire, pin, now: Date.now });
	await registry.caughtUp();
	return authorityBusOverWire(wire, registry, pin, Date.now, role);
}

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
