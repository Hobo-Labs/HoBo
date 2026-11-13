/**
 * One provisioned tenant on a real `nats-server`, as the integration tests
 * use it: the authority's bus, a test authority that signs the trust record,
 * member records and tickets, the callout responder, and devices connected
 * through `createNatsBusConnector` (or as raw connections, for probes).
 */
import { create } from "@bufbuild/protobuf";
import {
	type AuthorityBus,
	type DeviceKeys,
	DiscoverySchema,
	type FleetBus,
	type FleetLog,
	MemberState,
	Role,
	type Subscription,
} from "@hobo/fleet";
import {
	credsAuthenticator,
	type NatsConnection,
} from "@nats-io/transport-node";
import { mintConnectToken } from "../../src/bus/connect-token.js";
import { open } from "../../src/bus/connection.js";
import {
	connectAuthorityBus,
	createNatsBusConnector,
	startCalloutResponder,
} from "../../src/bus/index.js";
import { createTenantOn, INCARNATION, type Tenant } from "./fixture.js";
import type { TestNats } from "./nats-server.js";

const encoder = new TextEncoder();

export type Integration = Readonly<{
	nats: TestNats;
	tenant: Tenant;
	authority: AuthorityBus;
	refusals: readonly string[];
	/** An enrolled device with the given roles (executor by default). */
	device(roles?: Role[], state?: MemberState): Promise<DeviceKeys>;
	connect(keys: DeviceKeys): Promise<FleetBus>;
	/** A plain NATS connection authorised as the device, for permission probes. */
	raw(keys: DeviceKeys): Promise<NatsConnection>;
	close(): Promise<void>;
}>;

export async function startIntegration(nats: TestNats): Promise<Integration> {
	const refusals: string[] = [];
	const log: FleetLog = (event, fields) => {
		if (event === "hobo_fleet_callout_refused")
			refusals.push(String(fields.check));
	};
	const authority = await connectAuthorityBus({
		servers: [nats.url],
		credentials: nats.provisioned.staticCredentials.authority,
		trust: () => {
			throw new Error("no trust record published yet");
		},
		log,
	});
	const tenant = await createTenantOn(authority, Date.now);
	const responder: Subscription = await startCalloutResponder({
		servers: [nats.url],
		credentials: nats.provisioned.staticCredentials.authority,
		xkeySeed: nats.xkeySeed,
		scopedSeeds: nats.provisioned.scopedSeeds,
		registry: authority.registry,
		replay: authority.replay,
		incarnation: INCARNATION,
		now: Date.now,
		log,
	});
	const opened: { close(): Promise<void> }[] = [];
	const discovery = create(DiscoverySchema, {
		tenant: nats.tenant,
		natsUrls: [nats.url],
		natsSentinelCredentials: nats.provisioned.staticCredentials.sentinel,
		trust: tenant.trust,
	});
	return {
		nats,
		tenant,
		authority,
		refusals,
		device: (roles = [Role.EXECUTOR], state = MemberState.ACTIVE) =>
			tenant.device({ roles, state }),
		async connect(keys) {
			const bus = await createNatsBusConnector().connect({
				discovery,
				keys,
				trust: tenant.trust,
				ticket: () => tenant.ticket(keys),
				resumeFrom: {},
				log,
			});
			opened.push(bus);
			return bus;
		},
		async raw(keys) {
			const token = await mintConnectToken(keys, await tenant.ticket(keys));
			const connection = await open({
				servers: [nats.url],
				authenticator: [
					credsAuthenticator(
						encoder.encode(nats.provisioned.staticCredentials.sentinel),
					),
					() => ({ auth_token: token }),
				],
				name: keys.memberId,
				inboxPrefix: `_INBOX.${keys.memberId}`,
				persistent: false,
			});
			opened.push(connection);
			return connection;
		},
		async close() {
			for (const connection of opened)
				await connection.close().catch(() => undefined);
			await responder.stop();
			await authority.close();
		},
	};
}

/** True when the server refuses a request on `subject` with a permissions violation. */
export async function refused(
	connection: NatsConnection,
	subject: string,
	data: Uint8Array = new Uint8Array(),
): Promise<boolean> {
	try {
		await connection.request(subject, data, { timeout: 2_000 });
		return false;
	} catch (error) {
		return (
			error instanceof Error &&
			/permission/iu.test(`${error.message} ${String(error.cause)}`)
		);
	}
}

/** True when the server closes a subscription on `subject` for a permissions violation. */
export async function subscribeRefused(
	connection: NatsConnection,
	subject: string,
): Promise<boolean> {
	const subscription = connection.subscribe(subject);
	await connection.flush();
	const closed = await Promise.race([
		subscription.closed.then(
			() => subscription.isClosed(),
			() => true,
		),
		new Promise<boolean>((resolve) =>
			setTimeout(() => resolve(subscription.isClosed()), 1_000),
		),
	]);
	if (!subscription.isClosed()) subscription.unsubscribe();
	return closed;
}
