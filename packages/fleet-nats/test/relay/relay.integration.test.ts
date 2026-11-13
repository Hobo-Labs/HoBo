/**
 * O12 (`bus-relay`): the bus-relay transport on a real `nats-server`
 * (operator mode, TLS, a provisioned tenant).
 *
 * - `runTransportConformance` with each transport on its own authority
 *   connection, so the suite's own device keys can use any member's relay
 *   subjects: 64 MiB with a matching digest, and every refusal before a byte.
 * - Two enrolled executors, each on its own device connection with its own
 *   credentials, carry a session both ways through `fleet.relay.<member>.>`,
 *   which is all their permission templates allow.
 * - An observer, whose template does not allow publishing relay subjects,
 *   cannot open a session.
 *
 * The binary is `HOBO_FLEET_NATS_SERVER_BIN`, else `nats-server` on PATH. This
 * lane takes no skips: without the binary the suite fails.
 */
import { createHash, randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type DeviceKeys,
	type FleetBus,
	type FleetStream,
	Role,
	SESSION_GRANT_CONTEXT,
	SessionGrantSchema,
	SessionPurpose,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import { runTransportConformance } from "@hobo/fleet/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAuthorityBus } from "../../src/bus/index.js";
import { createBusRelayTransport } from "../../src/relay/index.js";
import { createRelayTransport } from "../../src/relay/transport.js";
import { relayIdentity } from "../../src/relay/wire.js";
import { type Integration, startIntegration } from "../support/integration.js";
import {
	requireBinary,
	startNats,
	type TestNats,
} from "../support/nats-server.js";

let nats: TestNats | undefined;
const opened: FleetBus[] = [];

beforeAll(async () => {
	requireBinary();
	nats = await startNats();
}, 60_000);

afterAll(async () => {
	for (const bus of opened) await bus.close().catch(() => undefined);
	await nats?.stop();
});

async function authorityBus(): Promise<FleetBus> {
	if (nats === undefined) throw new Error("nats-server did not start");
	const bus = await connectAuthorityBus({
		servers: [nats.url],
		credentials: nats.provisioned.staticCredentials.authority,
		trust: () => {
			throw new Error("no trust record published yet");
		},
		log: () => undefined,
	});
	opened.push(bus);
	return bus;
}

describe("the bus-relay transport on nats-server", () => {
	it("has nats-server", () => {
		requireBinary();
	});

	runTransportConformance(async () => {
		const first = await authorityBus();
		const second = await authorityBus();
		return [
			createBusRelayTransport(() => first),
			createBusRelayTransport(() => second),
		] as const;
	});
});

function grantBetween(
	initiator: DeviceKeys,
	acceptor: DeviceKeys,
): SignedEnvelope {
	const now = Date.now();
	const grant = create(SessionGrantSchema, {
		sessionId: `ses_${randomBytes(8).toString("hex")}`,
		tenant: "acme",
		initiator: {
			memberId: initiator.memberId,
			transportIdentity: relayIdentity(initiator.sealPublicKey),
			sealPublicKey: initiator.sealPublicKey,
		},
		acceptor: {
			memberId: acceptor.memberId,
			transportIdentity: relayIdentity(acceptor.sealPublicKey),
			sealPublicKey: acceptor.sealPublicKey,
		},
		purpose: SessionPurpose.BLOB,
		issuedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 60_000).toISOString(),
	});
	return create(SignedEnvelopeSchema, {
		context: SESSION_GRANT_CONTEXT,
		keyId: "test#1",
		payload: toBinary(SessionGrantSchema, grant),
		signature: randomBytes(64),
	});
}

async function digestOf(stream: FleetStream, count: number): Promise<string> {
	const hash = createHash("sha256");
	let got = 0;
	for await (const chunk of stream.read()) {
		hash.update(chunk);
		got += chunk.length;
		if (got >= count) break;
	}
	return got === count ? hash.digest("hex") : `short: ${got}`;
}

describe("device connections on nats-server", () => {
	let integration: Integration | undefined;
	beforeAll(async () => {
		if (nats === undefined) throw new Error("nats-server did not start");
		integration = await startIntegration(nats);
	}, 60_000);
	afterAll(async () => {
		await integration?.close();
	});

	it("carries a session between two executors on their own credentials", async () => {
		if (integration === undefined) throw new Error("no integration");
		const initiatorKeys = await integration.device([Role.EXECUTOR]);
		const acceptorKeys = await integration.device([Role.EXECUTOR]);
		const initiatorBus = await integration.connect(initiatorKeys);
		const acceptorBus = await integration.connect(acceptorKeys);
		const initiator = createBusRelayTransport(() => initiatorBus);
		const acceptor = createBusRelayTransport(() => acceptorBus);
		await initiator.start(initiatorKeys);
		await acceptor.start(acceptorKeys);
		const size = 4 * 1024 * 1024;
		const payload = randomBytes(size);
		const answer = randomBytes(256 * 1024);
		let seenPeer = "";
		let received = "";
		const subscription = acceptor.accept(
			async (peer) => {
				seenPeer = peer;
				return true;
			},
			async (stream) => {
				received = await digestOf(stream, size);
				await stream.write(answer);
			},
		);
		const outcome = await initiator.dial({
			grant: grantBetween(initiatorKeys, acceptorKeys),
			signal: new AbortController().signal,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		await outcome.value.write(payload);
		const back = await digestOf(outcome.value, answer.length);
		await outcome.value.close();
		expect(seenPeer).toBe(relayIdentity(initiatorKeys.sealPublicKey));
		expect(received).toBe(createHash("sha256").update(payload).digest("hex"));
		expect(back).toBe(createHash("sha256").update(answer).digest("hex"));
		await subscription.stop();
		await initiator.stop();
		await acceptor.stop();
	}, 60_000);

	it("gives an observer no session: its template cannot publish relay subjects", async () => {
		if (integration === undefined) throw new Error("no integration");
		const observerKeys = await integration.device([Role.OBSERVER]);
		const acceptorKeys = await integration.device([Role.EXECUTOR]);
		const observerBus = await integration.connect(observerKeys);
		const acceptorBus = await integration.connect(acceptorKeys);
		const observer = createRelayTransport(() => observerBus, {
			handshakeTimeoutMs: 3_000,
		});
		const acceptor = createBusRelayTransport(() => acceptorBus);
		await observer.start(observerKeys);
		await acceptor.start(acceptorKeys);
		let handled = 0;
		const subscription = acceptor.accept(
			async () => true,
			async () => {
				handled += 1;
			},
		);
		const outcome = await observer.dial({
			grant: grantBetween(observerKeys, acceptorKeys),
			signal: new AbortController().signal,
		});
		if (outcome.ok) await outcome.value.close();
		expect(outcome.ok).toBe(false);
		expect(handled).toBe(0);
		await subscription.stop();
		await observer.stop();
		await acceptor.stop();
	}, 60_000);
});
