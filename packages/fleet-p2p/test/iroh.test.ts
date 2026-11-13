/**
 * Assumptions A8 and A9 (design §13) against the pinned `@number0/iroh`
 * binding, two endpoints on this host talking over loopback with their direct
 * addresses (no relay, no discovery), and the transport conformance suite over
 * the real binding. Every test here may skip only when the binding has no
 * prebuilt for this platform, which is A8's fallback.
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { runTransportConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createIrohBinding, irohRelayMode, loadIroh } from "../src/iroh.js";
import { createEndpointTransport, P2P_ALPN } from "../src/transport.js";

const iroh = loadIroh();
const unavailable = iroh === undefined;

/** The Ed25519 public key of a 32-byte seed, by node:crypto, as lowercase hex. */
function publicKeyOf(seed: Uint8Array): string {
	const pkcs8 = Buffer.concat([
		Buffer.from("302e020100300506032b657004220420", "hex"),
		seed,
	]);
	const key = createPublicKey(
		createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
	);
	const spki = key.export({ format: "der", type: "spki" });
	return Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
}

describe("the iroh binding loader", () => {
	it("answers undefined when the binding cannot be loaded", () => {
		expect(
			loadIroh(() => {
				throw new Error("Cannot find native binding");
			}),
		).toBeUndefined();
	});
});

describe.skipIf(unavailable)("[A8] @number0/iroh two-endpoint test", () => {
	it("[A8] uses only the configured relays, one ALPN, and proves the remote endpoint id", async () => {
		if (iroh === undefined) return;
		const relays = [
			"https://relay-1.fleet.example/",
			"https://relay-2.fleet.example/",
		];
		expect([...irohRelayMode(iroh, relays).relayMap().urls()].sort()).toEqual(
			relays,
		);
		expect(irohRelayMode(iroh, []).relayMap().len()).toBe(0);

		const book = new Map<string, readonly string[]>();
		const binding = createIrohBinding(iroh, { addressBook: book });
		const server = await binding.bind({
			secretKey: randomBytes(32),
			relayUrls: [],
			alpn: P2P_ALPN,
		});
		const client = await binding.bind({
			secretKey: randomBytes(32),
			relayUrls: [],
			alpn: P2P_ALPN,
		});
		const otherAlpn = await createIrohBinding(iroh, { addressBook: book }).bind(
			{
				secretKey: randomBytes(32),
				relayUrls: [],
				alpn: new TextEncoder().encode("hobo/other/1"),
			},
		);
		try {
			const accepted = server.accept();
			const dialled = await client.connect(server.id);
			const incoming = await accepted;
			expect(incoming?.remoteId).toBe(client.id);
			expect(dialled.remoteId).toBe(server.id);
			const stream = await dialled.openStream();
			await stream.write(new Uint8Array([7, 8, 9]));
			await stream.finish();
			const served = await incoming?.acceptStream();
			expect([...((await served?.read(16)) ?? [])]).toEqual([7, 8, 9]);
			dialled.close();
			// An endpoint that serves another ALPN is not reached.
			await expect(otherAlpn.connect(server.id)).rejects.toThrow();
		} finally {
			await Promise.all([server.close(), client.close(), otherAlpn.close()]);
		}
	}, 60_000);

	it("[A9] binds with a caller-supplied secret key", async () => {
		if (iroh === undefined) return;
		const secretKey = randomBytes(32);
		const endpoint = await createIrohBinding(iroh, {}).bind({
			secretKey,
			relayUrls: [],
			alpn: P2P_ALPN,
		});
		try {
			expect(endpoint.id).toBe(publicKeyOf(secretKey));
		} finally {
			await endpoint.close();
		}
	}, 30_000);
});

describe.skipIf(unavailable)(
	"[A8] p2p transport over the real binding, direct on loopback",
	() => {
		const book = new Map<string, readonly string[]>();
		runTransportConformance(async () => {
			if (iroh === undefined) throw new Error("no binding");
			const binding = createIrohBinding(iroh, { addressBook: book });
			return [
				createEndpointTransport({ relayUrls: [], binding: () => binding }),
				createEndpointTransport({ relayUrls: [], binding: () => binding }),
			];
		});
	},
);
