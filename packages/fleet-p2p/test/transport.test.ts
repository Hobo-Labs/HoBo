import { create, toBinary } from "@bufbuild/protobuf";
import {
	SESSION_GRANT_CONTEXT,
	SessionGrantSchema,
	SessionPurpose,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import { runTransportConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createEndpointTransport, P2P_ALPN } from "../src/transport.js";
import { createTestDeviceKeys } from "./support/device-keys.js";
import { createFakeNetwork } from "./support/fake-network.js";

const RELAYS = ["https://relay-1.fleet.example/"];

function grantTo(acceptor: string, initiator: string): SignedEnvelope {
	const now = Date.now();
	return create(SignedEnvelopeSchema, {
		context: SESSION_GRANT_CONTEXT,
		keyId: "authority#1",
		payload: toBinary(
			SessionGrantSchema,
			create(SessionGrantSchema, {
				sessionId: "ses_test",
				initiator: { transportIdentity: initiator },
				acceptor: { transportIdentity: acceptor },
				purpose: SessionPurpose.BLOB,
				issuedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + 60_000).toISOString(),
			}),
		),
		signature: new Uint8Array(64),
	});
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("p2p transport over a fake endpoint", () => {
	const network = createFakeNetwork();
	runTransportConformance(async () => [
		createEndpointTransport({ relayUrls: RELAYS, binding: () => network }),
		createEndpointTransport({ relayUrls: RELAYS, binding: () => network }),
	]);

	it("binds one endpoint with the ALPN hobo/fleet/1 and only the configured relays", async () => {
		const fresh = createFakeNetwork();
		const transport = createEndpointTransport({
			relayUrls: RELAYS,
			binding: () => fresh,
		});
		const { transportIdentity } = await transport.start(createTestDeviceKeys());
		expect(transportIdentity).not.toBe("");
		expect(fresh.bound).toHaveLength(1);
		expect(Buffer.from(fresh.bound[0]?.alpn ?? []).toString()).toBe(
			"hobo/fleet/1",
		);
		expect(Buffer.from(P2P_ALPN).toString()).toBe("hobo/fleet/1");
		expect(fresh.bound[0]?.relayUrls).toEqual(RELAYS);
		await transport.stop();
	});

	it("derives a stable endpoint id from the device's SIGN key", async () => {
		const fresh = createFakeNetwork();
		const keys = createTestDeviceKeys();
		const first = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const one = await first.start(keys);
		await first.stop();
		const second = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const two = await second.start(keys);
		await second.stop();
		const other = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const three = await other.start(createTestDeviceKeys());
		await other.stop();
		expect(two.transportIdentity).toBe(one.transportIdentity);
		expect(three.transportIdentity).not.toBe(one.transportIdentity);
		expect(fresh.bound[0]?.secretKey).toHaveLength(32);
	});

	it("closes a connection whose first frame is not a grant, without asking authorise", async () => {
		const fresh = createFakeNetwork();
		const acceptor = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const { transportIdentity } = await acceptor.start(createTestDeviceKeys());
		let asked = 0;
		let handed = 0;
		const subscription = acceptor.accept(
			async () => {
				asked += 1;
				return true;
			},
			async () => {
				handed += 1;
			},
		);
		const raw = await fresh.bind({
			secretKey: new Uint8Array(32).fill(9),
			relayUrls: [],
			alpn: P2P_ALPN,
		});
		for (const frame of [
			new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 2, 3]),
			new Uint8Array([0, 0, 0, 3, 0xff, 0xff, 0xff]),
		]) {
			const connection = await raw.connect(transportIdentity);
			const stream = await connection.openStream();
			await stream.write(frame);
			await stream.finish();
			await connection.closed();
		}
		expect(asked).toBe(0);
		expect(handed).toBe(0);
		await subscription.stop();
		await acceptor.stop();
		await raw.close();
	});

	it("keeps accepting after a handler throws", async () => {
		const fresh = createFakeNetwork();
		const acceptor = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const dialler = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const to = (await acceptor.start(createTestDeviceKeys())).transportIdentity;
		const from = (await dialler.start(createTestDeviceKeys()))
			.transportIdentity;
		let handled = 0;
		const subscription = acceptor.accept(
			async () => true,
			async () => {
				handled += 1;
				throw new Error("handler failed");
			},
		);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const outcome = await dialler.dial({
				grant: grantTo(to, from),
				signal: new AbortController().signal,
			});
			expect(outcome.ok).toBe(true);
			if (outcome.ok) await outcome.value.close();
		}
		await pause(20);
		expect(handled).toBe(2);
		await subscription.stop();
		await acceptor.stop();
		await dialler.stop();
	});

	it("answers session-denied when the acceptor refuses, and refuses while nothing accepts", async () => {
		const fresh = createFakeNetwork();
		const acceptor = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const dialler = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const to = (await acceptor.start(createTestDeviceKeys())).transportIdentity;
		const from = (await dialler.start(createTestDeviceKeys()))
			.transportIdentity;
		const dial = () =>
			dialler.dial({
				grant: grantTo(to, from),
				signal: new AbortController().signal,
			});
		const unaccepted = await dial();
		expect(unaccepted.ok ? "carried" : unaccepted.error.code).toBe(
			"session-denied",
		);
		const subscription = acceptor.accept(
			async () => false,
			async () => {},
		);
		const refused = await dial();
		expect(refused.ok ? "carried" : refused.error.code).toBe("session-denied");
		await subscription.stop();
		await acceptor.stop();
		await dialler.stop();
		expect(fresh.open()).toBe(0);
	});

	it("fails a dial before start, and one whose grant does not decode", async () => {
		const fresh = createFakeNetwork();
		const dialler = createEndpointTransport({
			relayUrls: [],
			binding: () => fresh,
		});
		const signal = new AbortController().signal;
		const early = await dialler.dial({ grant: grantTo("a", "b"), signal });
		expect(early.ok ? "carried" : early.error.code).toBe("unavailable");
		await dialler.start(createTestDeviceKeys());
		const garbled = await dialler.dial({
			grant: create(SignedEnvelopeSchema, {
				context: SESSION_GRANT_CONTEXT,
				payload: new Uint8Array([0xff, 0xff, 0xff]),
			}),
			signal,
		});
		expect(garbled.ok ? "carried" : garbled.error.code).toBe("invalid-request");
		const unknownPeer = await dialler.dial({
			grant: grantTo("f".repeat(64), "b"),
			signal,
		});
		expect(unknownPeer.ok ? "carried" : unknownPeer.error.code).toBe(
			"unavailable",
		);
		await dialler.stop();
	});
});

describe("p2p transport on a platform without a prebuilt binding", () => {
	it("reports itself unavailable", async () => {
		const transport = createEndpointTransport({
			relayUrls: RELAYS,
			binding: () => undefined,
		});
		expect(transport.kind).toBe("p2p");
		const { transportIdentity } = await transport.start(createTestDeviceKeys());
		expect(transportIdentity).toBe("");
		const outcome = await transport.dial({
			grant: grantTo("a", "b"),
			signal: new AbortController().signal,
		});
		expect(outcome.ok ? "carried" : outcome.error.code).toBe("unavailable");
		const subscription = transport.accept(
			async () => true,
			async () => {},
		);
		await subscription.stop();
		await transport.stop();
	});
});
